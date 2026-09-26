// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Soroban RPC Health Monitor
 *
 * Proactively probes every configured Soroban RPC node on an interval and
 * classifies each one as healthy, degraded (sync delay / thin ledger history)
 * or down. Where the {@link RpcFailoverManager} reacts to failures only as
 * requests happen to hit a bad node, this monitor detects problems *before*
 * they impact traffic and:
 *
 *   1. Selects a backup node for failover — the active node is always the first
 *      healthy node in the configured order, so a degraded primary is bypassed.
 *   2. Alerts operators on every state transition (healthy → unhealthy and back)
 *      through the repository's existing webhook mechanism, formatted for Slack
 *      and Discord incoming webhooks.
 *
 * Detection rules per node:
 *   - down            : the probe throws or times out (unreachable / errored).
 *   - ledger_history  : RPC self-reports non-"healthy", or its retained ledger
 *                       window (latest − oldest) is below the configured floor.
 *   - sync_delay      : the node's latest ledger lags the best-observed node by
 *                       more than the configured threshold.
 *   - healthy         : none of the above.
 */

import { rpc } from "@stellar/stellar-sdk";
import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";
import { sendWebhook } from "./webhook.js";

/** Health classification for a single RPC node. */
export type RpcNodeStatus =
  | "healthy"
  | "sync_delay"
  | "ledger_history"
  | "down";

/** Result of probing one RPC node for its ledger state. */
export interface RpcLedgerProbe {
  /** Latest ledger sequence the node has ingested. */
  latestLedger: number;
  /** Oldest ledger sequence still retained by the node. */
  oldestLedger: number;
  /** The node's self-reported health status (e.g. "healthy"). */
  status: string;
}

/** Computed health of a single RPC node after a check cycle. */
export interface RpcNodeHealth {
  url: string;
  healthy: boolean;
  status: RpcNodeStatus;
  latestLedger: number | null;
  oldestLedger: number | null;
  /** How many ledgers this node trails the best-observed node, or null. */
  ledgerLag: number | null;
  latencyMs: number | null;
  error: string | null;
  lastCheckedAt: string;
}

/** Event emitted whenever a node's health transitions or failover occurs. */
export interface RpcHealthAlert {
  type: "unhealthy" | "recovered" | "failover";
  url: string;
  status: RpcNodeStatus;
  detail: string;
  /** The node now serving traffic after this event, if any. */
  activeUrl: string | null;
}

/** Probes a node's ledger state. Injectable so tests need no live network. */
export type LedgerProber = (url: string) => Promise<RpcLedgerProbe>;

/** Emits a health alert. Injectable so tests can assert on emitted events. */
export type AlertSink = (alert: RpcHealthAlert) => Promise<void> | void;

export interface RpcHealthMonitorOptions {
  /** Override the ledger prober (defaults to a live Soroban RPC probe). */
  prober?: LedgerProber;
  /** Override the alert sink (defaults to a Slack/Discord webhook post). */
  alert?: AlertSink;
  /** Ledgers a node may trail the best node before it is a sync delay. */
  syncLagThreshold?: number;
  /** Minimum retained ledger window; 0 disables the history check. */
  minLedgerRetention?: number;
  /** Per-node probe timeout in milliseconds. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3000;

/** Wrap a promise so it rejects if it does not settle within `timeoutMs`. */
function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Probe timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Default ledger prober: queries a Soroban RPC node's health and latest ledger.
 * `getHealth` exposes the retained ledger window; `getLatestLedger` gives an
 * authoritative sequence even on nodes whose health payload omits it.
 */
async function defaultProber(url: string): Promise<RpcLedgerProbe> {
  const server = new rpc.Server(url, {
    allowHttp: url.startsWith("http://"),
  });

  const [health, latest] = await Promise.all([
    server.getHealth(),
    server.getLatestLedger(),
  ]);

  const anyHealth = health as {
    status: string;
    latestLedger?: number;
    oldestLedger?: number;
  };

  return {
    status: anyHealth.status,
    latestLedger: anyHealth.latestLedger ?? latest.sequence,
    oldestLedger: anyHealth.oldestLedger ?? latest.sequence,
  };
}

/**
 * Default alert sink: posts a Slack/Discord-compatible message through the
 * existing signed-webhook helper. The payload carries both `text` (Slack) and
 * `content` (Discord) so a single URL works for either platform. When no
 * ALERT_WEBHOOK_URL is configured the alert degrades to a log line.
 */
async function defaultAlert(alert: RpcHealthAlert): Promise<void> {
  const url = loadConfig().alertWebhookUrl;
  if (!url) {
    logger.warn("[RpcHealthMonitor] Alert suppressed — no ALERT_WEBHOOK_URL set", {
      alert,
    });
    return;
  }

  const icon =
    alert.type === "recovered" ? "✅" : alert.type === "failover" ? "🔀" : "🚨";
  const message = `${icon} [RemitMortgage RPC] ${alert.detail}`;

  const result = await sendWebhook(url, {
    text: message,
    content: message,
    event: alert,
  });

  if (!result.success) {
    logger.error("[RpcHealthMonitor] Failed to deliver alert webhook", {
      error: result.error,
      status: result.status,
    });
  }
}

/**
 * Monitors a fixed set of Soroban RPC nodes, emitting alerts on health
 * transitions and exposing the current active (failover) node.
 */
export class RpcHealthMonitor {
  private readonly urls: string[];
  private readonly prober: LedgerProber;
  private readonly alert: AlertSink;
  private readonly syncLagThreshold: number;
  private readonly minLedgerRetention: number;
  private readonly timeoutMs: number;

  /** Last-known status per node, keyed by URL. */
  private statuses: Map<string, RpcNodeHealth> = new Map();
  /** URL currently selected to serve traffic, or null when all are down. */
  private activeUrl: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(urls: string[], options: RpcHealthMonitorOptions = {}) {
    if (!urls || urls.length === 0) {
      throw new Error("At least one RPC URL must be provided");
    }

    const config = loadConfig();

    this.urls = [...urls];
    this.prober = options.prober ?? defaultProber;
    this.alert = options.alert ?? defaultAlert;
    this.syncLagThreshold =
      options.syncLagThreshold ?? config.rpcSyncLagThreshold;
    this.minLedgerRetention =
      options.minLedgerRetention ?? config.rpcMinLedgerRetention;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Probe every node once, classify each, emit alerts for any transitions and
   * recompute the active failover node. Returns the fresh per-node health.
   */
  async checkOnce(): Promise<RpcNodeHealth[]> {
    const checkedAt = new Date().toISOString();

    // Probe all nodes concurrently so one slow node never serialises the sweep.
    const probes = await Promise.all(
      this.urls.map(async (url) => {
        const start = Date.now();
        try {
          const probe = await withTimeout(this.prober(url), this.timeoutMs);
          return { url, probe, latencyMs: Date.now() - start, error: null };
        } catch (err) {
          return {
            url,
            probe: null,
            latencyMs: Date.now() - start,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      })
    );

    // The best-observed ledger anchors the sync-delay comparison.
    const bestLedger = probes.reduce((best, p) => {
      if (p.probe && p.probe.latestLedger > best) return p.probe.latestLedger;
      return best;
    }, 0);

    const next: RpcNodeHealth[] = probes.map((p) =>
      this.classify(p, bestLedger, checkedAt)
    );

    // Detect and announce per-node transitions before swapping in the new map.
    for (const health of next) {
      this.emitTransition(health);
    }

    this.statuses = new Map(next.map((h) => [h.url, h]));
    this.updateActiveNode(next);

    return next;
  }

  /** Turn a raw probe result into a classified {@link RpcNodeHealth}. */
  private classify(
    p: {
      url: string;
      probe: RpcLedgerProbe | null;
      latencyMs: number;
      error: string | null;
    },
    bestLedger: number,
    checkedAt: string
  ): RpcNodeHealth {
    if (!p.probe) {
      return {
        url: p.url,
        healthy: false,
        status: "down",
        latestLedger: null,
        oldestLedger: null,
        ledgerLag: null,
        latencyMs: p.latencyMs,
        error: p.error,
        lastCheckedAt: checkedAt,
      };
    }

    const { latestLedger, oldestLedger, status } = p.probe;
    const ledgerLag = bestLedger > 0 ? bestLedger - latestLedger : 0;
    const retention = latestLedger - oldestLedger;

    let nodeStatus: RpcNodeStatus = "healthy";
    let error: string | null = null;

    if (status.toLowerCase() !== "healthy") {
      nodeStatus = "ledger_history";
      error = `RPC self-reported status "${status}"`;
    } else if (
      this.minLedgerRetention > 0 &&
      retention < this.minLedgerRetention
    ) {
      nodeStatus = "ledger_history";
      error = `Retained ledger window ${retention} below minimum ${this.minLedgerRetention}`;
    } else if (ledgerLag > this.syncLagThreshold) {
      nodeStatus = "sync_delay";
      error = `Lagging best node by ${ledgerLag} ledgers (threshold ${this.syncLagThreshold})`;
    }

    return {
      url: p.url,
      healthy: nodeStatus === "healthy",
      status: nodeStatus,
      latestLedger,
      oldestLedger,
      ledgerLag,
      latencyMs: p.latencyMs,
      error,
      lastCheckedAt: checkedAt,
    };
  }

  /** Fire unhealthy/recovered alerts when a node's health flips. */
  private emitTransition(health: RpcNodeHealth): void {
    const previous = this.statuses.get(health.url);
    // First observation of a healthy node is the steady state — stay quiet.
    if (!previous) {
      if (health.healthy) return;
    } else if (previous.healthy === health.healthy) {
      return;
    }

    if (health.healthy) {
      void this.dispatch({
        type: "recovered",
        url: health.url,
        status: health.status,
        detail: `RPC node ${health.url} recovered and is serving traffic again.`,
        activeUrl: this.activeUrl,
      });
    } else {
      void this.dispatch({
        type: "unhealthy",
        url: health.url,
        status: health.status,
        detail: `RPC node ${health.url} is unhealthy (${health.status}): ${health.error ?? "unknown reason"}.`,
        activeUrl: this.activeUrl,
      });
    }
  }

  /**
   * Recompute the active node as the first healthy node in configured order.
   * A change in the active node is itself an operational event, so it emits a
   * failover alert.
   */
  private updateActiveNode(next: RpcNodeHealth[]): void {
    const healthy = next.find((h) => h.healthy) ?? null;
    const newActive = healthy ? healthy.url : null;

    if (newActive !== this.activeUrl) {
      const previous = this.activeUrl;
      this.activeUrl = newActive;

      if (newActive && previous) {
        void this.dispatch({
          type: "failover",
          url: newActive,
          status: "healthy",
          detail: `Failover: routing Soroban RPC traffic from ${previous} to ${newActive}.`,
          activeUrl: newActive,
        });
      }
    }
  }

  /** Deliver an alert, swallowing sink errors so monitoring never crashes. */
  private async dispatch(alert: RpcHealthAlert): Promise<void> {
    try {
      await this.alert(alert);
    } catch (err) {
      logger.error("[RpcHealthMonitor] Alert sink threw", {
        error: err instanceof Error ? err.message : String(err),
        alert,
      });
    }
  }

  /** Snapshot of the most recent per-node health. */
  getStatuses(): RpcNodeHealth[] {
    return [...this.statuses.values()];
  }

  /** URL currently selected to serve traffic, or null when all nodes are down. */
  getActiveUrl(): string | null {
    return this.activeUrl;
  }

  /** Healthy node URLs in configured (failover) order. */
  getHealthyUrls(): string[] {
    return this.urls.filter((url) => this.statuses.get(url)?.healthy);
  }

  /** Begin periodic background probing. Idempotent. */
  start(intervalMs?: number): void {
    if (this.timer) return;

    const interval = intervalMs ?? loadConfig().rpcHealthCheckIntervalMs;

    // Run an immediate sweep so health is known without waiting a full interval.
    void this.checkOnce().catch((err) => {
      logger.error("[RpcHealthMonitor] Initial health check failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.timer = setInterval(() => {
      void this.checkOnce().catch((err) => {
        logger.error("[RpcHealthMonitor] Scheduled health check failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, interval);

    logger.info("[RpcHealthMonitor] Started", {
      nodes: this.urls.length,
      intervalMs: interval,
    });
  }

  /** Stop periodic probing. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("[RpcHealthMonitor] Stopped");
    }
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

let monitor: RpcHealthMonitor | null = null;

/** Lazily construct the shared monitor over the configured RPC node set. */
export function getRpcHealthMonitor(): RpcHealthMonitor {
  if (!monitor) {
    monitor = new RpcHealthMonitor(loadConfig().sorobanRpcUrls);
  }
  return monitor;
}

/** Start background RPC health monitoring (called on server boot). */
export function startRpcHealthMonitor(): void {
  getRpcHealthMonitor().start();
}
