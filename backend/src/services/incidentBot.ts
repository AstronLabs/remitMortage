// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";

export interface RunbookDefinition {
  alertType: string;
  title: string;
  runbookFile: string;
  runbookUrl: string;
  dashboardUrl: string;
  severity: "critical" | "high" | "medium" | "low";
  steps: string[];
}

export const RUNBOOK_REGISTRY: Record<string, RunbookDefinition> = {
  cost_anomaly: {
    alertType: "cost_anomaly",
    title: "AWS / Cloudflare Cloud Cost Anomaly",
    runbookFile: "docs/COST_ANOMALY_TRIAGE_RUNBOOK.md",
    runbookUrl: "https://github.com/AstronLabs/remitMortage/blob/main/docs/COST_ANOMALY_TRIAGE_RUNBOOK.md",
    dashboardUrl: "https://console.aws.amazon.com/costmanagement/home#/cost-explorer",
    severity: "high",
    steps: [
      "1. Identify spiking service or region in AWS Cost Explorer / Cloudflare Analytics.",
      "2. Check recent terraform deployments for unintended resource allocations.",
      "3. Isolate runaway Lambda invocations, NAT Gateway bandwidth, or Soroban RPC spam.",
      "4. Apply emergency throttling or provisioned capacity caps if budget threshold breached.",
    ],
  },
  db_connection_pool_exhaustion: {
    alertType: "db_connection_pool_exhaustion",
    title: "PostgreSQL Connection Pool Exhaustion",
    runbookFile: "docs/DB_CONNECTION_POOL_TUNING.md",
    runbookUrl: "https://github.com/AstronLabs/remitMortage/blob/main/docs/DB_CONNECTION_POOL_TUNING.md",
    dashboardUrl: "https://app.datadoghq.com/dash/remitmortgage-db-pool",
    severity: "critical",
    steps: [
      "1. Check active vs idle connections in /metrics or Datadog DB dashboard.",
      "2. Identify long-running transactions via `SELECT * FROM pg_stat_activity WHERE state != 'idle'`.",
      "3. Terminate stuck locks or leaked clients using `pg_terminate_backend(pid)`.",
      "4. Temporarily increase DB_CONNECTION_LIMIT or scale out PgBouncer read replicas.",
    ],
  },
  rpc_sync_lag: {
    alertType: "rpc_sync_lag",
    title: "Soroban RPC Node Sync Lag / Downtime",
    runbookFile: "devops/MULTI_REGION_FAILOVER_GUIDE.md",
    runbookUrl: "https://github.com/AstronLabs/remitMortage/blob/main/devops/MULTI_REGION_FAILOVER_GUIDE.md",
    dashboardUrl: "https://grafana.remitmortgage.com/d/soroban-rpc-health",
    severity: "high",
    steps: [
      "1. Check ledger sequence lag across all RPC nodes via /api/health/rpc.",
      "2. If primary RPC is lagging >100 ledgers, trigger automated failover to standby RPC endpoint.",
      "3. Inspect RPC provider status pages (SDF Testnet / Public Horizon).",
      "4. Re-index missed contract events from last verified ledger checkpoint.",
    ],
  },
  geo_dns_failover: {
    alertType: "geo_dns_failover",
    title: "Geo-DNS / CDN Health Check Routing Failure",
    runbookFile: "docs/GEO_DNS_CDN_TESTING.md",
    runbookUrl: "https://github.com/AstronLabs/remitMortage/blob/main/docs/GEO_DNS_CDN_TESTING.md",
    dashboardUrl: "https://dash.cloudflare.com/remitmortgage/traffic",
    severity: "critical",
    steps: [
      "1. Verify Route53 / Cloudflare health check probes for origin clusters.",
      "2. Route traffic away from degraded edge locations using DNS failover policies.",
      "3. Validate TLS certificates and origin ingress status.",
    ],
  },
  reentrancy_guard_violation: {
    alertType: "reentrancy_guard_violation",
    title: "Smart Contract Reentrancy Guard Violation",
    runbookFile: "docs/REENTRANCY_GUARDS.md",
    runbookUrl: "https://github.com/AstronLabs/remitMortage/blob/main/docs/REENTRANCY_GUARDS.md",
    dashboardUrl: "https://stellar.expert/explorer/public",
    severity: "critical",
    steps: [
      "1. Immediately evaluate triggering contract call and caller address.",
      "2. Verify if emergency protocol pause (`set_paused(true)`) should be triggered by admin multisig.",
      "3. Inspect audit log and Soroban event indexer for suspicious cross-contract interactions.",
    ],
  },
};

export interface IncidentState {
  incidentKey: string;
  alertType: string;
  status: "triggered" | "acknowledged" | "resolved";
  triggeredAt: Date;
  acknowledgedAt?: Date;
  acknowledgedBy?: string;
  resolvedAt?: Date;
  lastRunbookPostedAt?: Date;
  postCount: number;
}

export interface PagerDutyEvent {
  event_type: "incident.trigger" | "incident.acknowledge" | "incident.resolve" | "incident.reopen" | string;
  incident?: {
    id: string;
    incident_key?: string;
    title?: string;
    status?: string;
    urgency?: string;
    service?: { name: string; id: string };
    assignments?: Array<{ assignee: { summary: string } }>;
  };
  details?: Record<string, unknown>;
  alertType?: string;
  incidentKey?: string;
}

export interface IncidentBotResponse {
  success: boolean;
  action: "runbook_posted" | "suppressed_acknowledged" | "acknowledged" | "resolved" | "unhandled";
  incidentKey: string;
  runbook?: RunbookDefinition;
  message?: string;
}

class IncidentBotService {
  private incidentStore: Map<string, IncidentState> = new Map();

  /** Resolve alert type string from event payload title, service, or details. */
  public matchAlertType(event: PagerDutyEvent): string {
    if (event.alertType && RUNBOOK_REGISTRY[event.alertType]) {
      return event.alertType;
    }

    const searchBlob = `${event.incident?.title || ""} ${event.incident?.service?.name || ""} ${JSON.stringify(event.details || "")}`.toLowerCase();

    if (searchBlob.includes("cost") || searchBlob.includes("budget") || searchBlob.includes("billing")) {
      return "cost_anomaly";
    }
    if (searchBlob.includes("pool") || searchBlob.includes("db") || searchBlob.includes("connection") || searchBlob.includes("postgres")) {
      return "db_connection_pool_exhaustion";
    }
    if (searchBlob.includes("rpc") || searchBlob.includes("lag") || searchBlob.includes("soroban") || searchBlob.includes("stellar")) {
      return "rpc_sync_lag";
    }
    if (searchBlob.includes("dns") || searchBlob.includes("cdn") || searchBlob.includes("geo")) {
      return "geo_dns_failover";
    }
    if (searchBlob.includes("reentrancy") || searchBlob.includes("guard") || searchBlob.includes("contract")) {
      return "reentrancy_guard_violation";
    }

    return "db_connection_pool_exhaustion"; // fallback default
  }

  /** Get git deploy SHA */
  public getDeploySha(): string {
    return (
      process.env.GIT_COMMIT_SHA ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      process.env.HEROKU_SLUG_COMMIT ||
      "a9f4c32"
    ).slice(0, 7);
  }

  /**
   * Process an incoming PagerDuty incident webhook event.
   */
  public async handleWebhook(event: PagerDutyEvent): Promise<IncidentBotResponse> {
    const eventType = event.event_type || (event as unknown as { event?: string }).event || "incident.trigger";
    const incidentKey = event.incidentKey || event.incident?.incident_key || event.incident?.id || `inc_${Date.now()}`;
    const alertType = this.matchAlertType(event);
    const runbook = RUNBOOK_REGISTRY[alertType];

    logger.info("[IncidentBot] Processing PagerDuty webhook event", {
      eventType,
      incidentKey,
      alertType,
    });

    const existing = this.incidentStore.get(incidentKey);

    // ── Handle Acknowledgments ──────────────────────────────────────────────
    if (eventType === "incident.acknowledge" || eventType === "acknowledge") {
      const ackUser = event.incident?.assignments?.[0]?.assignee?.summary || "on-call-engineer";
      if (existing) {
        existing.status = "acknowledged";
        existing.acknowledgedAt = new Date();
        existing.acknowledgedBy = ackUser;
      } else {
        this.incidentStore.set(incidentKey, {
          incidentKey,
          alertType,
          status: "acknowledged",
          triggeredAt: new Date(),
          acknowledgedAt: new Date(),
          acknowledgedBy: ackUser,
          postCount: 0,
        });
      }

      logger.info("[IncidentBot] Incident acknowledged, suppressing future duplicate alerts", {
        incidentKey,
        ackUser,
      });

      return {
        success: true,
        action: "acknowledged",
        incidentKey,
        message: `Incident ${incidentKey} acknowledged by ${ackUser}`,
      };
    }

    // ── Handle Resolutions ──────────────────────────────────────────────────
    if (eventType === "incident.resolve" || eventType === "resolve") {
      this.incidentStore.delete(incidentKey);
      logger.info("[IncidentBot] Incident resolved and cleared from tracker", { incidentKey });
      return {
        success: true,
        action: "resolved",
        incidentKey,
        message: `Incident ${incidentKey} resolved`,
      };
    }

    // ── Handle Triggers ─────────────────────────────────────────────────────
    if (eventType === "incident.trigger" || eventType === "trigger" || eventType === "incident.reopen") {
      // Check if incident is already acknowledged -> suppress duplicate spam
      if (existing && existing.status === "acknowledged") {
        logger.info("[IncidentBot] Suppressing duplicate runbook post: incident is already acknowledged", {
          incidentKey,
          acknowledgedBy: existing.acknowledgedBy,
          acknowledgedAt: existing.acknowledgedAt,
        });

        return {
          success: true,
          action: "suppressed_acknowledged",
          incidentKey,
          message: `Suppressed duplicate alert: incident ${incidentKey} already acknowledged`,
        };
      }

      // Format and dispatch runbook message
      await this.dispatchSlackNotification(incidentKey, runbook, event);

      const state: IncidentState = existing || {
        incidentKey,
        alertType,
        status: "triggered",
        triggeredAt: new Date(),
        postCount: 0,
      };

      state.status = "triggered";
      state.lastRunbookPostedAt = new Date();
      state.postCount += 1;
      this.incidentStore.set(incidentKey, state);

      return {
        success: true,
        action: "runbook_posted",
        incidentKey,
        runbook,
        message: `Runbook posted for ${alertType}`,
      };
    }

    return {
      success: true,
      action: "unhandled",
      incidentKey,
    };
  }

  /**
   * Dispatches formatted runbook card into the Slack incident channel.
   */
  public async dispatchSlackNotification(
    incidentKey: string,
    runbook: RunbookDefinition,
    event: PagerDutyEvent
  ): Promise<boolean> {
    const config = loadConfig();
    const webhookUrl = config.opsSlackWebhookUrl || config.alertWebhookUrl;
    const deploySha = this.getDeploySha();
    const incidentTitle = event.incident?.title || runbook.title;

    const slackPayload = {
      text: `🚨 [${runbook.severity.toUpperCase()}] ${incidentTitle}`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `🚨 Incident Alert: ${runbook.title}`,
            emoji: true,
          },
        },
        {
          type: "section",
          fields: [
            {
              type: "mrkdwn",
              text: `*Severity:*\n\`${runbook.severity.toUpperCase()}\``,
            },
            {
              type: "mrkdwn",
              text: `*Deploy SHA:*\n\`${deploySha}\``,
            },
            {
              type: "mrkdwn",
              text: `*Incident ID:*\n\`${incidentKey}\``,
            },
            {
              type: "mrkdwn",
              text: `*Environment:*\n\`${process.env.NODE_ENV || "production"}\``,
            },
          ],
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*📋 Actionable Runbook Steps:*\n${runbook.steps.join("\n")}`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "📖 View Full Runbook",
                emoji: true,
              },
              url: runbook.runbookUrl,
              style: "primary",
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "📊 Open Telemetry Dashboard",
                emoji: true,
              },
              url: runbook.dashboardUrl,
            },
          ],
        },
      ],
    };

    if (!webhookUrl) {
      logger.info("[IncidentBot] Slack webhook URL not configured, logging payload locally", {
        slackPayload,
      });
      return true;
    }

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(slackPayload),
      });

      if (!response.ok) {
        logger.warn("[IncidentBot] Slack webhook returned non-200 status", {
          status: response.status,
          statusText: response.statusText,
        });
        return false;
      }

      logger.info("[IncidentBot] Runbook successfully dispatched to Slack", {
        incidentKey,
        alertType: runbook.alertType,
      });
      return true;
    } catch (err) {
      logger.error("[IncidentBot] Failed to send Slack alert", { error: err, incidentKey });
      return false;
    }
  }

  /** Reset internal state store (useful in tests) */
  public _resetState(): void {
    this.incidentStore.clear();
  }

  /** Get incident state */
  public getIncidentState(incidentKey: string): IncidentState | undefined {
    return this.incidentStore.get(incidentKey);
  }
}

export const incidentBot = new IncidentBotService();
