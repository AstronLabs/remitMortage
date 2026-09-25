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
