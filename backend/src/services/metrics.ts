// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Prometheus metrics registry
 *
 * Single source of truth for every metric in the process.  All modules import
 * their helpers from here so the registry is never duplicated.
 *
 * Metric naming follows the Prometheus convention:
 *   <namespace>_<subsystem>_<name>[_<unit>]
 *
 * Namespace : remitmortgage
 * Subsystems: http | indexer | rpc | queue
 *
 * Dependencies: prom-client (already available as "prom-client" in Node; no
 * additional install needed when the package is listed in package.json).
 */

import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
} from "prom-client";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Dedicated registry — avoids polluting the prom-client default registry and
 *  makes it easy to expose only our metrics on the /metrics endpoint. */
export const metricsRegistry = new Registry();

// Collect Node.js runtime defaults (heap, GC, event-loop lag, …) into our
// registry rather than the global default so everything appears on one endpoint.
collectDefaultMetrics({ register: metricsRegistry });

// ---------------------------------------------------------------------------
// Scheduled job leader election (issue #935)
// ---------------------------------------------------------------------------

/**
 * Outcomes of scheduled-job ticks on this instance. `executed`/`failed` mean
 * this instance was the leader for the run; the `skipped_*` outcomes mean
 * another instance already ran (or is running) it.
 */
export const scheduledJobRunsTotal = new Counter({
  name: "remitmortgage_scheduled_job_runs_total",
  help: "Scheduled job ticks handled by this instance, by outcome.",
  labelNames: ["job", "outcome"] as const,
  registers: [metricsRegistry],
});

/**
 * Scheduled runs this instance skipped because it was not the leader.
 * `lock_held`: another instance holds the job's advisory lock right now.
 * `recently_run`: another instance already completed this run.
 */
export const scheduledJobSkippedTotal = new Counter({
  name: "remitmortgage_scheduled_job_skipped_total",
  help: "Scheduled job runs skipped because another instance is the leader.",
  labelNames: ["job", "reason"] as const,
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// HTTP metrics
// ---------------------------------------------------------------------------

/**
 * Total number of HTTP requests handled, partitioned by method, route, and
 * status code.  Useful for RED (Rate / Error / Duration) dashboards.
 */
export const httpRequestsTotal = new Counter({
  name: "remitmortgage_http_requests_total",
  help: "Total number of HTTP requests received.",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [metricsRegistry],
});

/**
 * HTTP request duration histogram.
 *
 * Buckets cover the full latency spread expected for a Soroban-backed API:
 * sub-5 ms (cache hits) through 10 s (cold RPC calls).
 */
export const httpRequestDurationSeconds = new Histogram({
  name: "remitmortgage_http_request_duration_seconds",
  help: "HTTP request latency in seconds.",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

/**
 * Total HTTP requests partitioned by API version (issue #847), so a
 * retirement decision for an old version is made from real traffic data
 * rather than a guess. Version comes from the client-sent `Api-Version`
 * request header, defaulting to `CURRENT_API_VERSION` (middleware/
 * apiVersioning.ts) when absent — nearly all traffic today, since no client
 * sends the header yet.
 */
export const httpRequestsByVersionTotal = new Counter({
  name: "remitmortgage_http_requests_by_version_total",
  help: "Total number of HTTP requests received, partitioned by API version.",
  labelNames: ["version", "method", "route"] as const,
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Indexer / event-listener metrics
// ---------------------------------------------------------------------------

/**
 * The ledger sequence number of the most recently successfully indexed event
 * batch.  A stalled gauge (flat line in Grafana) means the indexer has stopped
 * advancing — the most important signal for indexer health.
 */
export const indexerLastIndexedLedger = new Gauge({
  name: "remitmortgage_indexer_last_indexed_ledger",
  help: "Ledger sequence of the most recently indexed event batch.",
  registers: [metricsRegistry],
});

/**
 * Latest ledger reported by the Soroban RPC node on each poll.  Comparing
 * this against `indexer_last_indexed_ledger` gives the indexing lag in ledgers.
 */
export const indexerLatestNetworkLedger = new Gauge({
  name: "remitmortgage_indexer_latest_network_ledger",
  help: "Latest ledger sequence reported by the Soroban RPC node.",
  registers: [metricsRegistry],
});

/**
 * Derived lag gauge: network_ledger - last_indexed_ledger.
 * Alerting threshold: > 100 ledgers behind indicates the indexer cannot keep up.
 */
export const indexerLagLedgers = new Gauge({
  name: "remitmortgage_indexer_lag_ledgers",
  help: "Number of ledgers the indexer is behind the network tip.",
  registers: [metricsRegistry],
});

/**
 * Total count of on-chain contract events successfully decoded and processed,
 * broken down by event topic (deposit, withdraw, disburse, repay, release).
 */
export const indexerEventsProcessedTotal = new Counter({
  name: "remitmortgage_indexer_events_processed_total",
  help: "Total on-chain contract events processed by the event listener.",
  labelNames: ["topic"] as const,
  registers: [metricsRegistry],
});

/**
 * Total count of events skipped because they were missing required fields
 * (borrower address or amount).  Persistent growth signals a contract ABI change.
 */
export const indexerEventsSkippedTotal = new Counter({
  name: "remitmortgage_indexer_events_skipped_total",
  help: "On-chain events skipped due to missing borrower/amount fields.",
  labelNames: ["topic"] as const,
  registers: [metricsRegistry],
});

/**
 * Total number of RPC poll errors encountered by the event listener.
 * Bumped on every caught exception inside the poll loop.
 */
export const indexerRpcErrorsTotal = new Counter({
  name: "remitmortgage_indexer_rpc_errors_total",
  help: "Total Soroban RPC poll errors encountered by the event listener.",
  registers: [metricsRegistry],
});

/**
 * Current exponential-backoff attempt count.  Resets to 0 on a healthy poll.
 * A sustained non-zero value means the indexer is stuck in a reconnect loop.
 */
export const indexerBackoffAttempt = new Gauge({
  name: "remitmortgage_indexer_backoff_attempt",
  help: "Current exponential-backoff attempt count (0 = healthy).",
  registers: [metricsRegistry],
});

/**
 * Number of events received in the most recent poll batch.  Useful for
 * spotting burst activity or silent batches that return zero events.
 */
export const indexerBatchSize = new Gauge({
  name: "remitmortgage_indexer_batch_size",
  help: "Number of events returned in the most recent poll batch.",
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// RPC latency metrics
// ---------------------------------------------------------------------------

/**
 * Duration histogram for outbound Soroban RPC getEvents calls.
 * Buckets reflect expected RPC round-trip times (50 ms – 15 s).
 */
export const rpcGetEventsDurationSeconds = new Histogram({
  name: "remitmortgage_rpc_get_events_duration_seconds",
  help: "Soroban RPC getEvents call latency in seconds.",
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15],
  registers: [metricsRegistry],
});

/**
 * Duration histogram for generic outbound Soroban RPC calls (simulate, send, …).
 * Partitioned by operation name.
 */
export const rpcCallDurationSeconds = new Histogram({
  name: "remitmortgage_rpc_call_duration_seconds",
  help: "Soroban RPC call latency in seconds, by operation.",
  labelNames: ["operation"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15],
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Queue / scheduler metrics
// ---------------------------------------------------------------------------

/**
 * Number of pending background jobs in the scheduler queue at the time of the
 * last scrape.  Backed by a simple in-process counter updated by job
 * enqueue/complete callbacks.
 */
export const schedulerQueueDepth = new Gauge({
  name: "remitmortgage_scheduler_queue_depth",
  help: "Number of pending jobs in the background scheduler queue.",
  labelNames: ["job_type"] as const,
  registers: [metricsRegistry],
});

/**
 * Total number of background jobs completed, by type and outcome.
 */
export const schedulerJobsTotal = new Counter({
  name: "remitmortgage_scheduler_jobs_total",
  help: "Total background jobs executed.",
  labelNames: ["job_type", "outcome"] as const,
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// API key quota metrics
// ---------------------------------------------------------------------------

/**
 * Total number of API requests rejected for exceeding their key's
 * per-billing-period quota, by plan. See middleware/apiKeyQuota.ts.
 */
export const apiKeyQuotaExceededTotal = new Counter({
  name: "remitmortgage_apikey_quota_exceeded_total",
  help: "Total API requests rejected for exceeding the caller's per-billing-period quota.",
  labelNames: ["plan"] as const,
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Tenant request rate-limit metrics
// ---------------------------------------------------------------------------

/** Current request-window usage for each tenant and plan. */
export const tenantRateLimitUsage = new Gauge({
  name: "remitmortgage_tenant_rate_limit_usage",
  help: "Authenticated requests used by each tenant in the current rate-limit window.",
  labelNames: ["tenant_id", "plan"] as const,
  registers: [metricsRegistry],
});

/** Requests rejected after exceeding a tenant's plan-based request budget. */
export const tenantRateLimitExceededTotal = new Counter({
  name: "remitmortgage_tenant_rate_limit_exceeded_total",
  help: "Authenticated tenant requests rejected for exceeding the plan-based request budget.",
  labelNames: ["tenant_id", "plan"] as const,
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Request payload limit metrics
// ---------------------------------------------------------------------------

/**
 * Total requests rejected by the payload size/shape limits, by reason
 * (`too_large` | `too_deep` | `array_too_long`) and the matched route rule
 * (a configured path prefix, or `default`). See middleware/payloadLimits.ts.
 */
export const payloadRejectedTotal = new Counter({
  name: "remitmortgage_payload_rejected_total",
  help: "Total requests rejected with 413 for exceeding body size, JSON depth or array length limits.",
  labelNames: ["reason", "route"] as const,
  registers: [metricsRegistry],
});

/**
 * Reserved object keys (`__proto__`, `constructor`, `prototype`) removed from
 * an incoming request, labelled by guard mode and route prefix. A non-zero
 * rate means someone is probing for prototype pollution (issue #885).
 * See middleware/prototypePollutionGuard.ts.
 */
export const prototypePollutionStrippedTotal = new Counter({
  name: "remitmortgage_prototype_pollution_stripped_total",
  help: "Total reserved object keys stripped from request bodies and query strings.",
  labelNames: ["mode", "route"] as const,
  registers: [metricsRegistry],
});

/**
 * Admin requests rejected by device binding, labelled by failure reason and
 * enforcement mode (issue #886). A rising `device_mismatch` or
 * `replayed_proof` rate is session theft in progress, not a config problem.
 * See middleware/adminDeviceBinding.ts.
 */
export const adminDeviceBindingFailuresTotal = new Counter({
  name: "remitmortgage_admin_device_binding_failures_total",
  help: "Total admin requests rejected because the device proof did not match the bound session.",
  labelNames: ["reason", "mode"] as const,
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Graceful shutdown metrics
// ---------------------------------------------------------------------------

/** HTTP requests currently being served; drained to 0 during shutdown. */
export const httpInFlightRequests = new Gauge({
  name: "remitmortgage_http_in_flight_requests",
  help: "Number of HTTP requests currently in flight.",
  registers: [metricsRegistry],
});

/** 1 once the process has begun graceful shutdown (readiness is failing). */
export const shuttingDown = new Gauge({
  name: "remitmortgage_shutting_down",
  help: "1 when the process is draining for shutdown, 0 otherwise.",
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/**
 * Observe a Soroban RPC getEvents call.
 *
 * Usage:
 * ```ts
 * const done = startRpcTimer();
 * const result = await server.getEvents(request);
 * done();
 * ```
 */
export function startRpcTimer(): () => void {
  const end = rpcGetEventsDurationSeconds.startTimer();
  return end;
}

/**
 * Update the three indexer position gauges in a single call.
 *
 * @param lastIndexed   Sequence of the last ledger we processed events from.
 * @param networkTip    Latest ledger reported by the RPC node.
 */
export function recordIndexerPosition(lastIndexed: number, networkTip: number): void {
  indexerLastIndexedLedger.set(lastIndexed);
  indexerLatestNetworkLedger.set(networkTip);
  indexerLagLedgers.set(Math.max(0, networkTip - lastIndexed));
}
