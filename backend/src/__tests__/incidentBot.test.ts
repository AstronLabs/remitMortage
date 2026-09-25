// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { incidentBot, RUNBOOK_REGISTRY } from "../services/incidentBot.js";
import express from "express";
import request from "supertest";
import { incidentWebhookRouter } from "../routes/incidentWebhooks.js";

// Mock fetch for Slack dispatch
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

jest.mock("../config.js", () => ({
  loadConfig: jest.fn(() => ({
    opsSlackWebhookUrl: "https://hooks.slack.com/services/MOCK/WEBHOOK/123",
    alertWebhookUrl: "https://hooks.slack.com/services/MOCK/WEBHOOK/123",
  })),
}));

describe("Automated Incident Response Bot (#486)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    incidentBot._resetState();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it("maps cost anomaly alerts to the Cost Anomaly Triage runbook", () => {
    const alertType = incidentBot.matchAlertType({
      event_type: "incident.trigger",
      incident: {
        id: "inc-101",
        title: "AWS CloudWatch Billing Alarm: Unexpected Spend Surge",
      },
    });

    expect(alertType).toBe("cost_anomaly");
    expect(RUNBOOK_REGISTRY[alertType].runbookFile).toBe("docs/COST_ANOMALY_TRIAGE_RUNBOOK.md");
    expect(RUNBOOK_REGISTRY[alertType].severity).toBe("high");
  });

  it("maps database pool exhaustion alerts to the DB Pool Tuning runbook", () => {
    const alertType = incidentBot.matchAlertType({
      event_type: "incident.trigger",
      incident: {
        id: "inc-102",
        title: "PostgreSQL Database Connection Pool Exhausted (>90% utilization)",
      },
    });

    expect(alertType).toBe("db_connection_pool_exhaustion");
    expect(RUNBOOK_REGISTRY[alertType].runbookFile).toBe("docs/DB_CONNECTION_POOL_TUNING.md");
    expect(RUNBOOK_REGISTRY[alertType].severity).toBe("critical");
  });

  it("dispatches runbook steps and deploy SHA to Slack on incident trigger", async () => {
    const result = await incidentBot.handleWebhook({
      event_type: "incident.trigger",
      incidentKey: "PD-12345",
      incident: {
        id: "PD-12345",
        title: "High RPC Sync Lag on Soroban Testnet Node",
      },
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe("runbook_posted");
    expect(result.runbook?.alertType).toBe("rpc_sync_lag");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://hooks.slack.com/services/MOCK/WEBHOOK/123");

    const payload = JSON.parse(options.body);
    expect(payload.text).toContain("RPC Sync Lag");
    const blocksStr = JSON.stringify(payload.blocks);
    expect(blocksStr).toContain("Deploy SHA");
    expect(blocksStr).toContain("Actionable Runbook Steps");
  });

  it("suppresses duplicate runbook posts when an incident is acknowledged", async () => {
    const incidentKey = "PD-8888";

    // 1. First trigger posts runbook
    const trigResult1 = await incidentBot.handleWebhook({
      event_type: "incident.trigger",
      incidentKey,
      incident: { id: incidentKey, title: "Database connection pool exhausted" },
    });
    expect(trigResult1.action).toBe("runbook_posted");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // 2. Incident is acknowledged by on-call
    const ackResult = await incidentBot.handleWebhook({
      event_type: "incident.acknowledge",
      incidentKey,
      incident: {
        id: incidentKey,
        assignments: [{ assignee: { summary: "Alice (On-Call)" } }],
      },
    });
    expect(ackResult.action).toBe("acknowledged");

    // Verify incident tracker state
    const state = incidentBot.getIncidentState(incidentKey);
    expect(state?.status).toBe("acknowledged");
    expect(state?.acknowledgedBy).toBe("Alice (On-Call)");

    // 3. Repeated alert triggers while acknowledged -> MUST BE SUPPRESSED
    const trigResult2 = await incidentBot.handleWebhook({
      event_type: "incident.trigger",
      incidentKey,
      incident: { id: incidentKey, title: "Database connection pool exhausted" },
    });

    expect(trigResult2.action).toBe("suppressed_acknowledged");
    // mockFetch should NOT have been called again for the duplicate
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("clears incident from tracker when resolved", async () => {
    const incidentKey = "PD-9999";

    await incidentBot.handleWebhook({
      event_type: "incident.trigger",
      incidentKey,
      incident: { id: incidentKey, title: "Cost anomaly in us-east-1" },
    });

    expect(incidentBot.getIncidentState(incidentKey)).toBeDefined();

    const resolveResult = await incidentBot.handleWebhook({
      event_type: "incident.resolve",
      incidentKey,
      incident: { id: incidentKey },
    });

    expect(resolveResult.action).toBe("resolved");
    expect(incidentBot.getIncidentState(incidentKey)).toBeUndefined();
  });
});

describe("POST /api/webhooks/pagerduty Endpoint", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/webhooks/pagerduty", incidentWebhookRouter);

  beforeEach(() => {
    jest.clearAllMocks();
    incidentBot._resetState();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it("processes PagerDuty v2/v3 webhook messages array", async () => {
    const response = await request(app)
      .post("/api/webhooks/pagerduty")
      .send({
        messages: [
          {
            event_type: "incident.trigger",
            incident: {
              id: "INC-ROUTER-1",
              title: "PostgreSQL DB connection pool exhausted",
            },
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.processed).toBe(1);
    expect(response.body.results[0].action).toBe("runbook_posted");
  });

  it("rejects non-object request payload with 400", async () => {
    const response = await request(app)
      .post("/api/webhooks/pagerduty")
      .send(null as unknown as object);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_payload");
  });
});
