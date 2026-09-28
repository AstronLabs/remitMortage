// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Connection lease-leak detector for the Prisma connection pool.
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 *
 * A "connection leak" happens when a Prisma operation is issued but its
 * promise is never resolved or rejected — usually because an exception escaped
 * an error handler without being awaited, or because an early `return` skipped
 * the code that was supposed to release the connection.  The pool counts that
 * slot as in-use indefinitely; once enough slots leak the pool exhausts and all
 * new requests fail with P2024.
 *
 * The saturation metrics in `dbPoolMetrics.ts` make the *approach* to
 * exhaustion visible, but they cannot tell you *which* call site is leaking.
 * This module fills that gap.
 *
 * ── Approach ────────────────────────────────────────────────────────────────
 *
 * Every Prisma operation is assigned a unique checkout ID before it runs.
 * `recordCheckout` stores:
 *   - wall-clock timestamp (to compute age)
 *   - originating call stack (to identify the call site)
 *   - Prisma model + operation (for labels and log context)
 *
 * `releaseCheckout` removes the entry when the operation settles.
 *
 * A background sweeper (`startLeakDetector`) fires every
 * `DB_LEAK_SWEEP_INTERVAL_MS` milliseconds and scans every live entry.
 * Any entry whose age exceeds `DB_CONNECTION_LEAK_THRESHOLD_MS`:
 *   1. Is logged with WARN severity, including the originating stack, model,
 *      operation, checkout time, and current age — everything needed to find
 *      the leaking call site.
 *   2. Increments `dbPoolLeakEventsTotal`.
 *   3. Updates `dbPoolLongHeldConnections` to the live count of over-threshold
 *      entries.
 *
 * The sweeper never cancels or forcibly releases an operation; it is purely
 * observational.  Killing an in-flight Prisma query would corrupt the
 * connection state and is not safe to do from outside the pool.
 *
 * ── Stack capture trade-offs ─────────────────────────────────────────────────
 *
 * Capturing a `new Error().stack` on every operation adds a small but
 * non-zero overhead (~1–5 µs per call on V8).  The capture is therefore
 * behind the `DB_LEAK_DETECTION_CAPTURE_STACK` env var (default true) so it
 * can be disabled in high-throughput environments that already have full
 * distributed tracing and don't need the stack for origin attribution.
 */

import logger from "../utils/logger.js";
import {
  dbPoolLongHeldConnections,
  dbPoolLeakEventsTotal,
} from "./dbPoolMetrics.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckoutRecord {
  /** Unique identifier for this checkout instance. */
  id: string;
  /** Prisma model name (e.g. "LoanApplication") or "raw" for $queryRaw. */
  model: string;
  /** Prisma operation name (e.g. "findMany", "create"). */
  operation: string;
  /** Epoch ms when the operation was issued. */
  checkedOutAt: number;
  /**
   * Captured call stack at checkout time.  The first few frames are internal
   * to this module; meaningful application frames start at index 3–5.
   *
   * `null` when stack capture is disabled via
   * `DB_LEAK_DETECTION_CAPTURE_STACK=false`.
   */
  stack: string | null;
  /** OpenTelemetry trace ID at checkout time, if available. */
  traceId: string | null;
  /** Correlation request ID from cls-rtracer, if available. */
  requestId: string | null;
  /**
   * Set to `true` the first time this checkout is flagged by the sweeper.
   * Prevents the leak-event counter from being incremented again on subsequent
   * sweeps for the same live checkout (avoids double-counting a single leak
   * across multiple sweep cycles).
   */
  alreadyFlagged: boolean;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Live checkouts keyed by checkout ID. */
const activeCheckouts = new Map<string, CheckoutRecord>();

/** Monotonically increasing counter used to generate unique checkout IDs. */
let checkoutSeq = 0;

/** Handle returned by `setInterval`; `null` when the sweeper is not running. */
let sweepTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

/**
 * Minimum age (ms) at which an operation is considered a potential leak.
 *
 * Defaults to 30 000 ms (30 s) — long enough to exclude intentionally slow
 * bulk operations under normal load, short enough to catch a genuinely stuck
 * connection while the pool still has headroom.
 *
 * Override via `DB_CONNECTION_LEAK_THRESHOLD_MS`.
 */
export function getLeakThresholdMs(): number {
  const raw = process.env.DB_CONNECTION_LEAK_THRESHOLD_MS;
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}

/**
 * How often the sweeper checks for leaked checkouts.
 *
 * Defaults to 10 000 ms (10 s).  Set shorter in development to catch leaks
 * faster; set longer if the process has very high query concurrency and the
 * overhead of scanning `activeCheckouts` on every sweep is measurable.
 *
 * Override via `DB_LEAK_SWEEP_INTERVAL_MS`.
 */
export function getSweepIntervalMs(): number {
  const raw = process.env.DB_LEAK_SWEEP_INTERVAL_MS;
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
}

/** Whether to capture a call stack on each checkout (default `true`). */
function captureStackEnabled(): boolean {
  return process.env.DB_LEAK_DETECTION_CAPTURE_STACK !== "false";
}

// ---------------------------------------------------------------------------
// Stack / context helpers
// ---------------------------------------------------------------------------

/**
 * Capture the current call stack, skipping the first `skip` frames so the
 * returned string starts at the application frame that issued the query.
 *
 * Returns `null` when stack capture is disabled.
 */
function captureStack(skip = 3): string | null {
  if (!captureStackEnabled()) return null;
  const e = { stack: "" };
  Error.captureStackTrace(e);
  const lines = (e.stack ?? "").split("\n");
  // Drop "Error" header + the first `skip` internal frames.
  return lines.slice(skip + 1).join("\n") || null;
}

/** Read the active OpenTelemetry trace ID without importing the full SDK. */
function currentTraceId(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { trace } = require("@opentelemetry/api") as typeof import("@opentelemetry/api");
    return trace.getActiveSpan()?.spanContext().traceId ?? null;
  } catch {
    return null;
  }
}

/** Read the cls-rtracer request ID without importing the full library. */
function currentRequestId(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rTracer = require("cls-rtracer") as { id: () => string | undefined };
    return rTracer.id() ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a new database operation checkout.
 *
 * Called by the Prisma extension **before** the operation is issued to the
 * pool.  Returns a unique checkout ID that must be passed to `releaseCheckout`
 * when the operation settles.
 *
 * @param model    Prisma model name ("LoanApplication", "AuditLog", …) or "raw".
 * @param operation  Prisma operation ("findMany", "create", "update", …) or
 *                   "queryRaw" / "executeRaw".
 */
export function recordCheckout(model: string, operation: string): string {
  const id = `chk_${++checkoutSeq}_${Date.now()}`;
  activeCheckouts.set(id, {
    id,
    model,
    operation,
    checkedOutAt: Date.now(),
    stack: captureStack(),
    traceId: currentTraceId(),
    requestId: currentRequestId(),
    alreadyFlagged: false,
  });
  return id;
}

/**
 * Release a checkout when its associated Prisma operation settles.
 *
 * After release the entry is removed from the active registry and the
 * long-held-connections gauge is refreshed.  Safe to call with an unknown ID
 * (no-op) so callers never need to guard against double-release.
 */
export function releaseCheckout(id: string): void {
  activeCheckouts.delete(id);
  // Refresh the gauge after every release so it reflects the live count.
  refreshLongHeldGauge();
}

/**
 * Return a snapshot of every currently active checkout record.
 *
 * Intended for health-check endpoints and tests.  The returned array is a
 * shallow copy; mutating it does not affect the internal registry.
 */
export function getActiveCheckouts(): CheckoutRecord[] {
  return Array.from(activeCheckouts.values());
}

/** Current number of active checkouts (regardless of age). */
export function getActiveCheckoutCount(): number {
  return activeCheckouts.size;
}

// ---------------------------------------------------------------------------
// Gauge helper
// ---------------------------------------------------------------------------

function refreshLongHeldGauge(): void {
  const thresholdMs = getLeakThresholdMs();
  const now = Date.now();
  let longHeldCount = 0;
  for (const rec of activeCheckouts.values()) {
    if (now - rec.checkedOutAt >= thresholdMs) {
      longHeldCount++;
    }
  }
  dbPoolLongHeldConnections.set(longHeldCount);
}

// ---------------------------------------------------------------------------
// Sweeper
// ---------------------------------------------------------------------------

/**
 * One sweep cycle: scan every active checkout and flag those that have
 * exceeded the leak threshold.
 *
 * Exported for direct use in tests (call instead of waiting for the timer).
 */
export function runSweep(): void {
  const thresholdMs = getLeakThresholdMs();
  const now = Date.now();
  let longHeldCount = 0;

  for (const rec of activeCheckouts.values()) {
    const ageMs = now - rec.checkedOutAt;
    if (ageMs < thresholdMs) continue;

    longHeldCount++;

    if (!rec.alreadyFlagged) {
      // Mark first-seen so subsequent sweeps don't re-increment the counter
      // for the same live checkout.
      rec.alreadyFlagged = true;
      dbPoolLeakEventsTotal.inc({ model: rec.model, operation: rec.operation });

      logger.warn("[db-leak] Long-held database connection detected", {
        checkoutId: rec.id,
        model: rec.model,
        operation: rec.operation,
        checkedOutAt: new Date(rec.checkedOutAt).toISOString(),
        ageMs,
        thresholdMs,
        traceId: rec.traceId ?? undefined,
        requestId: rec.requestId ?? undefined,
        // The stack is the primary artifact for identifying the leaking call
        // site.  It is intentionally included at WARN level so it is captured
        // by log aggregators without needing DEBUG verbosity.
        originStack: rec.stack ?? "(stack capture disabled)",
      });
    } else {
      // Already flagged — emit a lower-severity reminder every sweep so
      // operators can see the connection is *still* held, not just that it
      // was once held too long.
      logger.warn("[db-leak] Long-held connection still open (repeated)", {
        checkoutId: rec.id,
        model: rec.model,
        operation: rec.operation,
        ageMs,
        thresholdMs,
        traceId: rec.traceId ?? undefined,
        requestId: rec.requestId ?? undefined,
      });
    }
  }

  dbPoolLongHeldConnections.set(longHeldCount);
}

/**
 * Start the background sweep timer.
 *
 * Safe to call multiple times — a second call while the timer is already
 * running is a no-op, so it is safe to call unconditionally at server startup
 * and in tests.
 *
 * @param intervalMs  Override the sweep interval (used in tests to tick
 *                    manually without waiting for a real timer).
 */
export function startLeakDetector(intervalMs?: number): void {
  if (sweepTimer !== null) return; // already running

  const interval = intervalMs ?? getSweepIntervalMs();
  sweepTimer = setInterval(() => {
    try {
      runSweep();
    } catch (err) {
      // A sweep failure must never crash the process; log and continue.
      logger.error("[db-leak] Sweep error", { err });
    }
  }, interval);

  // `unref()` ensures the timer does not prevent the Node.js event loop from
  // exiting when there is nothing else to keep it alive (e.g. in tests).
  if (sweepTimer.unref) sweepTimer.unref();

  logger.info("[db-leak] Connection leak detector started", {
    thresholdMs: getLeakThresholdMs(),
    sweepIntervalMs: interval,
    stackCaptureEnabled: captureStackEnabled(),
  });
}

/**
 * Stop the sweep timer and clear all tracked checkouts.
 *
 * Intended for graceful shutdown and test teardown.
 */
export function stopLeakDetector(): void {
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  activeCheckouts.clear();
  dbPoolLongHeldConnections.set(0);
}

// ---------------------------------------------------------------------------
// Prisma client extension factory
// ---------------------------------------------------------------------------

/**
 * Build the Prisma client extension that wraps every operation with the leak
 * detector.
 *
 * Apply via `client.$extends(createLeakDetectorExtension())` in `db.ts`, after
 * the pool-metrics extension and before the slow-query extension.
 *
 * The extension is kept as a factory returning a plain object (no import of
 * the Prisma client here) so this module stays unit-testable without a
 * generated client or a live database — mirroring the pattern used by
 * `createDbPoolMetricsExtension` in `dbPoolMetrics.ts`.
 */
export function createLeakDetectorExtension() {
  return {
    name: "remitmortgage-db-leak-detector",
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
          const checkoutId = recordCheckout(model ?? "raw", operation);
          try {
            return await query(args);
          } finally {
            // `finally` guarantees release even when the query throws, so a
            // rejected operation can never leave a dangling checkout entry and
            // skew the leak gauge upward indefinitely.
            releaseCheckout(checkoutId);
          }
        },
      },
    },
  };
}
