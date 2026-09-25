// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";

const mockFindMany = jest.fn();

jest.mock("../services/db.js", () => ({
  prisma: {
    webhookDelivery: { findMany: (...args: any[]) => mockFindMany(...args) },
  },
}));
jest.mock("../services/inviteCode.js", () => ({ promoteWaitlistBatch: jest.fn() }));
jest.mock("../services/loanStore.js", () => ({ bulkReviewApplications: jest.fn() }));
jest.mock("../services/webhook.js", () => ({ sendWebhook: jest.fn() }));
jest.mock("../jobs/escrowReconciliation.js", () => ({ runEscrowReconciliation: jest.fn() }));
jest.mock("../config.js", () => ({
  loadConfig: () => ({ adminApiKey: "test-admin-key", webhookLatencySlaMs: 1000, webhookLatencyWindowMinutes: 30 }),
}));
jest.mock("../middleware/auth.js", () => ({
  requireAdmin: (req: any, res: any, next: any) =>
    req.headers.authorization === "Bearer test-admin-key"
      ? next()
      : res.status(401).json({ error: "missing_authorization" }),
}));

import { adminRouter } from "../routes/admin.js";
import { buildLatencyReport, percentile, type DeliveryAttemptRecord } from "../services/webhookLatency.js";

const NOW = new Date("2026-09-25T12:00:00.000Z");

function attempt(
  subscriptionId: string,
  outcome: string,
  latencyMs: number,
  overrides: Partial<DeliveryAttemptRecord> = {}
): DeliveryAttemptRecord {
  const completedAt = new Date(NOW.getTime() - 60_000);
  return {
    subscriptionId,
    url: `https://${subscriptionId}.example.com/hook`,
    label: subscriptionId,
    outcome,
    dispatchedAt: new Date(completedAt.getTime() - latencyMs),
    completedAt,
    ...overrides,
  };
}

describe("percentile", () => {
  it("uses the nearest-rank method", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 99)).toBe(99);
    expect(percentile(values, 100)).toBe(100);
  });

  it("handles small and empty samples", () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
  });
});

describe("buildLatencyReport", () => {
  it("computes per-endpoint percentiles from successful deliveries only", () => {
    const attempts = [
      ...Array.from({ length: 20 }, (_, i) => attempt("fast", "success", (i + 1) * 10)),
      attempt("fast", "retry", 99_999),
      attempt("fast", "dlq", 99_999),
    ];

    const report = buildLatencyReport(attempts, { windowMinutes: 60, slaMs: 5000, now: NOW });
    const fast = report.endpoints[0];

    expect(fast).toMatchObject({
      subscriptionId: "fast",
      delivered: 20,
      retries: 1,
      deadLettered: 1,
      p50Ms: 100,
      p95Ms: 190,
      p99Ms: 200,
      maxMs: 200,
      slaBreached: false,
      breachReason: null,
    });
  });

  it("flags an endpoint whose p95 exceeds the SLA threshold", () => {
    const attempts = [
      ...Array.from({ length: 10 }, () => attempt("healthy", "success", 200)),
      ...Array.from({ length: 18 }, () => attempt("degrading", "success", 300)),
      attempt("degrading", "success", 8000),
      attempt("degrading", "success", 9000),
    ];

    const report = buildLatencyReport(attempts, { windowMinutes: 60, slaMs: 5000, now: NOW });

    expect(report.breachedCount).toBe(1);
    expect(report.endpoints[0]).toMatchObject({
      subscriptionId: "degrading",
      p95Ms: 8000,
      slaBreached: true,
      breachReason: "p95_over_sla",
    });
    expect(report.endpoints[1]).toMatchObject({ subscriptionId: "healthy", slaBreached: false });
  });

  it("does not flag when p95 sits exactly on the threshold", () => {
    const attempts = Array.from({ length: 10 }, () => attempt("edge", "success", 5000));
    const report = buildLatencyReport(attempts, { windowMinutes: 60, slaMs: 5000, now: NOW });
    expect(report.endpoints[0].slaBreached).toBe(false);
  });

  it("flags an endpoint that only dead-lettered in the window", () => {
    const report = buildLatencyReport(
      [attempt("down", "retry", 1000), attempt("down", "dlq", 3000)],
      { windowMinutes: 60, slaMs: 5000, now: NOW }
    );
    expect(report.endpoints[0]).toMatchObject({
      delivered: 0,
      p95Ms: null,
      slaBreached: true,
      breachReason: "dlq_without_success",
    });
  });

  it("ignores legacy rows without timestamps", () => {
    const report = buildLatencyReport(
      [attempt("old", "success", 100, { dispatchedAt: null })],
      { windowMinutes: 60, slaMs: 5000, now: NOW }
    );
    expect(report.endpoints[0]).toMatchObject({ delivered: 0, p50Ms: null, slaBreached: false });
  });
});

describe("GET /api/admin/webhooks/latency", () => {
  const app = express();
  app.use("/api/admin", adminRouter);

  beforeEach(() => mockFindMany.mockReset());

  function row(subscriptionId: string, outcome: string, latencyMs: number) {
    const a = attempt(subscriptionId, outcome, latencyMs);
    return {
      subscriptionId,
      outcome,
      dispatchedAt: a.dispatchedAt,
      completedAt: a.completedAt,
      subscription: { url: a.url, label: a.label },
    };
  }

  it("requires admin auth", async () => {
    const res = await request(app).get("/api/admin/webhooks/latency");
    expect(res.status).toBe(401);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("returns percentiles matching recorded deliveries using configured defaults", async () => {
    mockFindMany.mockResolvedValue([
      row("sub-a", "success", 100),
      row("sub-a", "success", 200),
      row("sub-a", "success", 300),
      row("sub-a", "success", 4000),
    ]);

    const before = Date.now();
    const res = await request(app)
      .get("/api/admin/webhooks/latency")
      .set("Authorization", "Bearer test-admin-key");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ windowMinutes: 30, slaMs: 1000, breachedCount: 1 });
    expect(res.body.endpoints[0]).toMatchObject({
      subscriptionId: "sub-a",
      url: "https://sub-a.example.com/hook",
      p50Ms: 200,
      p95Ms: 4000,
      p99Ms: 4000,
      slaBreached: true,
    });

    const where = mockFindMany.mock.calls[0][0].where.completedAt;
    const windowMs = where.lte.getTime() - where.gte.getTime();
    expect(windowMs).toBe(30 * 60_000);
    expect(where.lte.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("accepts window and SLA overrides", async () => {
    mockFindMany.mockResolvedValue([row("sub-a", "success", 4000)]);

    const res = await request(app)
      .get("/api/admin/webhooks/latency?windowMinutes=120&slaMs=10000")
      .set("Authorization", "Bearer test-admin-key");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ windowMinutes: 120, slaMs: 10000, breachedCount: 0 });
  });

  it.each(["windowMinutes=0", "windowMinutes=abc", "windowMinutes=20000", "slaMs=-5", "slaMs=1.5"])(
    "rejects invalid query %s",
    async (query) => {
      const res = await request(app)
        .get(`/api/admin/webhooks/latency?${query}`)
        .set("Authorization", "Bearer test-admin-key");
      expect(res.status).toBe(400);
    }
  );
});
