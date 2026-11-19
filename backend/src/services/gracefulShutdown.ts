// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Graceful shutdown with connection draining (issue #827).
 *
 * Deploys and scale-down events send SIGTERM. Instead of dying mid-request the
 * process:
 *
 *   1. flips to "shutting down", which fails the readiness probe immediately so
 *      the load balancer stops routing here;
 *   2. stops accepting new connections and lets in-flight requests finish
 *      (bounded by a timeout, after which stragglers are cut off);
 *   3. drains queue workers — a running job is allowed to finish; jobs still
 *      running at the timeout are put back on the queue so another replica
 *      picks them up instead of waiting for stall detection;
 *   4. closes the queues, Redis and the database last, once nothing can use
 *      them any more.
 *
 * This module is deliberately free of `process.exit` and signal wiring so it
 * can be tested; src/index.ts owns those.
 */

import type { Server } from "http";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Job } from "bullmq";
import { httpInFlightRequests, shuttingDown as shuttingDownGauge } from "./metrics.js";
import logger from "../utils/logger.js";

// ── Shutdown state ───────────────────────────────────────────────────────

let shuttingDown = false;
let inFlight = 0;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function getInFlightRequestCount(): number {
  return inFlight;
}

/** Flips the process into draining mode; the readiness probe fails from here on. */
export function markShuttingDown(): void {
  shuttingDown = true;
  shuttingDownGauge.set(1);
}

/** Test hook: restore the pristine, serving state. */
export function resetShutdownState(): void {
  shuttingDown = false;
  inFlight = 0;
  shuttingDownGauge.set(0);
  httpInFlightRequests.set(0);
}

// ── HTTP: in-flight tracking and request gating ──────────────────────────

/** Paths that must keep answering while draining so probes and scrapes see the truth. */
const ALWAYS_SERVED = [/^\/api\/health(\/|$)/, /^\/api\/status(\/|$)/, /^\/metrics(\/|$)/];

/**
 * Counts requests in flight and, once shutdown has begun, tells clients to drop
 * the connection after the current response (`Connection: close`) so keep-alive
 * sockets do not hold the drain open. A request that still arrives on an
 * already-open socket is turned away with 503 + `Retry-After` rather than
 * started, since it could not be guaranteed to finish.
 *
 * Mount it first, ahead of every other middleware.
 */
export function inFlightRequestTracker(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (shuttingDown) {
      res.setHeader("Connection", "close");
      if (!ALWAYS_SERVED.some((re) => re.test(req.path))) {
        res.setHeader("Retry-After", "1");
        res.status(503).json({
          error: "shutting_down",
          message: "Server is shutting down; retry against another instance",
          statusCode: 503,
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    inFlight++;
    httpInFlightRequests.set(inFlight);
    // 'close' fires whether the response completed or the client went away.
    res.once("close", () => {
      inFlight = Math.max(0, inFlight - 1);
      httpInFlightRequests.set(inFlight);
    });
    next();
  };
}

export interface HttpDrainResult {
  /** True when the timeout elapsed and remaining connections were destroyed. */
  forced: boolean;
  inFlightAtTimeout: number;
}

const IDLE_SWEEP_MS = 50;

/**
 * Stops accepting connections and resolves once every connection has ended.
 * Idle keep-alive sockets are closed immediately and again as requests finish;
 * at `timeoutMs` whatever is left is destroyed.
 */
export async function drainHttpServer(server: Server, timeoutMs: number): Promise<HttpDrainResult> {
  if (!server.listening) return { forced: false, inFlightAtTimeout: 0 };

  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections?.();
  const sweep = setInterval(() => server.closeIdleConnections?.(), IDLE_SWEEP_MS);

  let forced = false;
  let inFlightAtTimeout = 0;
  const timer = setTimeout(() => {
    forced = true;
    inFlightAtTimeout = inFlight;
    logger.warn("[shutdown] request drain timed out; closing remaining connections", {
      inFlight: inFlightAtTimeout,
      timeoutMs,
    });
    server.closeAllConnections?.();
  }, timeoutMs);

  try {
    await closed;
  } finally {
    clearTimeout(timer);
    clearInterval(sweep);
  }
  return { forced, inFlightAtTimeout };
}

// ── Workers: finish or requeue ───────────────────────────────────────────

/** The slice of a BullMQ Worker that draining needs. */
export interface DrainableWorker {
  close(force?: boolean): Promise<void>;
}

/** The slice of a BullMQ Job that requeueing needs. */
type RequeueableJob = Pick<Job, "id" | "moveToWait">;

/**
 * Remembers which jobs a worker is running (and the lock token each holds) so
 * they can be handed back to the queue if they outlive the shutdown timeout.
 */
export class ActiveJobTracker {
  private readonly active = new Map<string, { job: RequeueableJob; token?: string }>();
  private seq = 0;

  get size(): number {
    return this.active.size;
  }

  /** Wraps a BullMQ processor so every run registers itself while it executes. */
  wrap<J extends RequeueableJob, R>(
    processor: (job: J, token?: string) => Promise<R>
  ): (job: J, token?: string) => Promise<R> {
    return async (job, token) => {
      const key = `${job.id ?? "job"}#${this.seq++}`;
      this.active.set(key, { job, token });
      try {
        return await processor(job, token);
      } finally {
        this.active.delete(key);
      }
    };
  }

  /**
   * Moves every still-running job back to the waiting list. Returns how many
   * were requeued. A job that already finished (or lost its lock) is skipped.
   */
  async requeueAll(): Promise<number> {
    const entries = [...this.active.values()];
    const results = await Promise.allSettled(entries.map(({ job, token }) => job.moveToWait(token)));
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        logger.warn("[shutdown] could not requeue active job", {
          jobId: entries[i].job.id,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    });
    return results.filter((r) => r.status === "fulfilled").length;
  }
}

export interface WorkerDrainResult {
  name: string;
  /** True when running jobs outlived the timeout and the worker was force-closed. */
  forced: boolean;
  requeued: number;
}

/**
 * Closes a worker gracefully: it stops taking jobs and waits for the ones in
 * progress. If they are still running at `timeoutMs`, they are requeued and the
 * worker is force-closed, so a stuck job cannot block the deploy.
 */
export async function drainWorker(
  name: string,
  worker: DrainableWorker,
  timeoutMs: number,
  tracker?: ActiveJobTracker
): Promise<WorkerDrainResult> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const graceful = worker.close().then(() => "closed" as const);

  try {
    if ((await Promise.race([graceful, timedOut])) === "closed") {
      return { name, forced: false, requeued: 0 };
    }
  } finally {
    clearTimeout(timer);
  }

  const running = tracker?.size ?? 0;
  logger.warn("[shutdown] worker drain timed out; requeueing running jobs", { worker: name, running, timeoutMs });
  // Requeue first, while this worker still holds the locks, then cut it loose.
  const requeued = tracker ? await tracker.requeueAll() : 0;
  await worker.close(true);
  return { name, forced: true, requeued };
}

// ── Orchestration ────────────────────────────────────────────────────────

export interface ShutdownTimeouts {
  /** How long in-flight HTTP requests may keep running. */
  requestTimeoutMs: number;
  /** How long running queue jobs may keep running before being requeued. */
  jobTimeoutMs: number;
}

export function loadShutdownTimeouts(env: NodeJS.ProcessEnv = process.env): ShutdownTimeouts {
  const read = (value: string | undefined, fallback: number) => {
    const n = Number(value);
    return value !== undefined && value.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  // Defaults sit inside Kubernetes' 30s terminationGracePeriodSeconds.
  return {
    requestTimeoutMs: read(env.SHUTDOWN_REQUEST_TIMEOUT_MS, 15_000),
    jobTimeoutMs: read(env.SHUTDOWN_JOB_TIMEOUT_MS, 15_000),
  };
}

export interface ShutdownPlan extends ShutdownTimeouts {
  server: Server;
  /** Synchronous stop functions for timers/schedulers that start new work. */
  stopSchedulers?: ReadonlyArray<() => void>;
  /** Worker drains; each receives the job timeout and returns its own result. */
  drainWorkers?: ReadonlyArray<(jobTimeoutMs: number) => Promise<WorkerDrainResult | void>>;
  /** Shared resources, closed one after another once HTTP and workers are idle. */
  closeResources?: ReadonlyArray<{ name: string; close: () => Promise<unknown> }>;
}

export interface ShutdownResult {
  signal: string;
  durationMs: number;
  http: HttpDrainResult;
  workers: WorkerDrainResult[];
  /** Names of resources/steps that threw; shutdown still ran to completion. */
  errors: string[];
}

let shutdownInProgress: Promise<ShutdownResult> | null = null;

/**
 * Runs the shutdown sequence once. A repeated signal (SIGTERM followed by
 * SIGINT, say) returns the in-progress run instead of starting another.
 */
export function gracefulShutdown(signal: string, plan: ShutdownPlan): Promise<ShutdownResult> {
  if (shutdownInProgress) return shutdownInProgress;
  shutdownInProgress = run(signal, plan);
  return shutdownInProgress;
}

/** Test hook. */
export function resetGracefulShutdown(): void {
  shutdownInProgress = null;
  resetShutdownState();
}

async function run(signal: string, plan: ShutdownPlan): Promise<ShutdownResult> {
  const startedAt = Date.now();
  const errors: string[] = [];
  logger.info(`[shutdown] received ${signal}, draining`, {
    inFlight,
    requestTimeoutMs: plan.requestTimeoutMs,
    jobTimeoutMs: plan.jobTimeoutMs,
  });

  // 1. Readiness fails from this point.
  markShuttingDown();

  // 2. No more scheduled work.
  for (const stop of plan.stopSchedulers ?? []) {
    try {
      stop();
    } catch (err) {
      errors.push("scheduler");
      logger.error("[shutdown] failed to stop a scheduler", { err });
    }
  }

  // 3. HTTP and workers drain concurrently; both finish before any shared
  //    resource is closed, since both may still be using the database/Redis.
  const [http, workerResults] = await Promise.all([
    drainHttpServer(plan.server, plan.requestTimeoutMs),
    Promise.allSettled((plan.drainWorkers ?? []).map((drain) => drain(plan.jobTimeoutMs))),
  ]);

  const workers: WorkerDrainResult[] = [];
  for (const result of workerResults) {
    if (result.status === "fulfilled") {
      if (result.value) workers.push(result.value);
    } else {
      errors.push("worker");
      logger.error("[shutdown] worker drain failed", { err: result.reason });
    }
  }

  // 4. Shared resources, in the order given (queues -> redis -> database).
  for (const { name, close } of plan.closeResources ?? []) {
    try {
      await close();
    } catch (err) {
      errors.push(name);
      logger.error(`[shutdown] failed to close ${name}`, { err });
    }
  }

  const durationMs = Date.now() - startedAt;
  logger.info("[shutdown] complete", {
    durationMs,
    httpForced: http.forced,
    workersForced: workers.filter((w) => w.forced).map((w) => w.name),
    requeuedJobs: workers.reduce((n, w) => n + w.requeued, 0),
    errors,
  });
  return { signal, durationMs, http, workers, errors };
}
