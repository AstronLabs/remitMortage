// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Connection pool saturation metrics.
 *
 * Pool exhaustion shows up to users as request timeouts (Prisma P2024,
 * "Timed out fetching a new connection from the connection pool"). By the time
 * those errors appear the pool is already fully saturated, so the point of
 * this module is to make the *approach* to saturation visible early enough to
 * act on.
 *
 * ── Why these numbers and not Prisma's own ──────────────────────────────────
 *
 * Prisma used to expose engine-internal pool gauges through `prisma.$metrics`
 * (`prisma_pool_connections_open`, `_busy`, `_idle`). That API does not exist
 * in Prisma 7, which this project is on — the query-compiler runtime dropped
 * it. So the pool's internal counters are simply not readable from the client.
 *
 * What *is* observable is demand. Every Prisma operation in flight needs a
 * pool connection to make progress, so the number of operations issued and not
 * yet resolved is the load the pool is being asked to carry. Comparing that
 * against the configured `connection_limit` gives a faithful utilization
 * reading:
 *
 *   utilization = min(in_flight, limit) / limit
 *
 * It saturates at 1.0, and anything queued beyond the limit shows up
 * separately in `db_pool_queued_queries`. Sustained utilization near 1.0 with
 * a non-zero queue is the "approaching exhaustion" signal; P2024 errors,
 * counted here too, are the confirmation that it went too far.
 *
 * The one thing this cannot do that engine metrics could is distinguish an
 * idle-but-open connection from a closed one. That distinction does not
 * matter for saturation alerting, which is what this is for.
 */

import { Counter, Gauge, Histogram } from "prom-client";

import { metricsRegistry } from "./metrics.js";
import { resolvePoolSettings } from "./dbPoolConfig.js";

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** Configured ceiling — the denominator of the utilization ratio. */
export const dbPoolMaxConnections = new Gauge({
  name: "remitmortgage_db_pool_max_connections",
  help: "Configured maximum number of database connections for this process.",
  registers: [metricsRegistry],
});

/** Prisma operations issued and not yet resolved. */
export const dbPoolInFlightQueries = new Gauge({
  name: "remitmortgage_db_pool_in_flight_queries",
  help: "Database operations issued and not yet resolved.",
  registers: [metricsRegistry],
});

/**
 * Fraction of the configured pool in use, 0..1. Clamped at 1 so the ratio
 * stays interpretable as a percentage; overflow is in `queued_queries`.
 */
export const dbPoolUtilizationRatio = new Gauge({
  name: "remitmortgage_db_pool_utilization_ratio",
  help: "Database connection pool utilization (in-flight / max), clamped to 1.",
  registers: [metricsRegistry],
});

/**
 * Operations waiting for a connection because in-flight demand exceeds the
 * pool. Any sustained non-zero value here means requests are being delayed.
 */
export const dbPoolQueuedQueries = new Gauge({
  name: "remitmortgage_db_pool_queued_queries",
  help: "Operations waiting for a free connection (in-flight beyond the pool limit).",
  registers: [metricsRegistry],
});

/** High-water mark of in-flight demand since the last scrape-window reset. */
export const dbPoolPeakInFlightQueries = new Gauge({
  name: "remitmortgage_db_pool_peak_in_flight_queries",
  help: "Highest in-flight operation count observed since process start.",
  registers: [metricsRegistry],
});

/**
 * End-to-end duration of a Prisma operation. Under contention this rises
 * because time is spent waiting for a connection, so a latency increase that
 * tracks utilization is the signature of pool pressure rather than slow SQL.
 */
export const dbQueryDurationSeconds = new Histogram({
  name: "remitmortgage_db_query_duration_seconds",
  help: "Prisma operation duration in seconds, including time spent waiting for a connection.",
  labelNames: ["model", "operation"] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [metricsRegistry],
});

/**
 * Pool acquisition timeouts (Prisma P2024). Non-zero means the pool was
 * genuinely exhausted and a user-facing request failed because of it.
 */
export const dbPoolTimeoutsTotal = new Counter({
  name: "remitmortgage_db_pool_timeouts_total",
  help: "Database operations that failed waiting for a pool connection (Prisma P2024).",
  registers: [metricsRegistry],
});

/** All failed operations, partitioned by Prisma error code. */
export const dbQueryErrorsTotal = new Counter({
  name: "remitmortgage_db_query_errors_total",
  help: "Failed database operations, by Prisma error code.",
  labelNames: ["code"] as const,
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

/** Prisma's error code for "timed out fetching a connection from the pool". */
export const POOL_TIMEOUT_CODE = "P2024";

let inFlight = 0;
let peakInFlight = 0;

/** Current configured limit. Re-read on init so tests can vary the env. */
let connectionLimit = resolvePoolSettings().connectionLimit;

function publishUtilization(): void {
  dbPoolInFlightQueries.set(inFlight);
  dbPoolPeakInFlightQueries.set(peakInFlight);

  const used = Math.min(inFlight, connectionLimit);
  dbPoolUtilizationRatio.set(connectionLimit > 0 ? used / connectionLimit : 0);
  dbPoolQueuedQueries.set(Math.max(0, inFlight - connectionLimit));
}

/**
 * Read the pool limit from the environment and publish the static gauges.
 * Call once at startup, before the first query.
 */
export function initDbPoolMetrics(
  env: NodeJS.ProcessEnv = process.env
): { connectionLimit: number } {
  connectionLimit = resolvePoolSettings(env).connectionLimit;
  dbPoolMaxConnections.set(connectionLimit);
  publishUtilization();
  return { connectionLimit };
}

/** The limit the gauges are currently computed against. */
export function getTrackedConnectionLimit(): number {
  return connectionLimit;
}

/** Extract a Prisma error code from an unknown thrown value. */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length > 0 ? code : "unknown";
}

/**
 * Wrap one database operation so it is counted against the pool.
 *
 * Increments before awaiting and decrements in a `finally`, so a rejected
 * operation can never leak an in-flight slot and strand the gauge at a false
 * high — which would page ops for a pool that is actually idle.
 */
export async function trackDbOperation<T>(
  meta: { model?: string; operation?: string },
  run: () => Promise<T>
): Promise<T> {
  inFlight += 1;
  if (inFlight > peakInFlight) peakInFlight = inFlight;
  publishUtilization();

  const labels = {
    model: meta.model ?? "raw",
    operation: meta.operation ?? "unknown",
  };
  const stopTimer = dbQueryDurationSeconds.startTimer(labels);

  try {
    return await run();
  } catch (error) {
    const code = errorCode(error);
    dbQueryErrorsTotal.inc({ code });
    if (code === POOL_TIMEOUT_CODE) {
      dbPoolTimeoutsTotal.inc();
    }
    throw error;
  } finally {
    stopTimer();
    inFlight -= 1;
    publishUtilization();
  }
}

/**
 * Build the Prisma client extension that routes every operation through
 * `trackDbOperation`.
 *
 * Kept as a factory returning a plain object rather than calling
 * `prisma.$extends` here, so this module never imports the Prisma client and
 * stays unit-testable without a generated client or a database.
 */
export function createDbPoolMetricsExtension() {
  return {
    name: "remitmortgage-db-pool-metrics",
    query: {
      $allModels: {
        async $allOperations({
          model,
          operation,
          args,
          query,
        }: {
          model?: string;
          operation: string;
          args: unknown;
          query: (args: unknown) => Promise<unknown>;
        }) {
          return trackDbOperation({ model, operation }, () => query(args));
        },
      },
    },
  };
}

/** Test hook — clears in-flight and peak tracking. */
export function resetDbPoolMetricsState(): void {
  inFlight = 0;
  peakInFlight = 0;
  publishUtilization();
}

/** Current in-flight count. Exposed for tests and health reporting. */
export function getInFlightCount(): number {
  return inFlight;
}
