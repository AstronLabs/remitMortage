// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Advisory-lock leader election for scheduled jobs (issue #935).
 *
 * With several application instances running, every instance's cron fires the
 * same job. Wrapping the job here makes exactly one instance execute a given
 * scheduled run:
 *
 *   1. Take a PostgreSQL advisory lock named after the job. Instances that
 *      cannot get it skip the run (`lock_held`).
 *   2. While holding the lock, ignore the tick if another instance already
 *      completed the job within `minIntervalMs` (`recently_run`). This closes
 *      the gap where a straggler's cron fires just *after* the leader released
 *      the lock.
 *   3. Record which instance ran the job in `ScheduledJobRun`.
 *
 * The lock is a transaction-scoped advisory lock (`pg_try_advisory_xact_lock`)
 * held by an open transaction for the duration of the job. If the holder
 * crashes or loses its connection, PostgreSQL rolls the transaction back and
 * the lock is released automatically — there is no TTL to wait out. The next
 * lock holder marks the dead holder's `running` row `abandoned` and proceeds.
 *
 * See docs/JOB_LEADER_ELECTION.md.
 */

import { createHash, randomBytes } from "crypto";
import os from "os";
import logger from "../utils/logger.js";
import { scheduledJobRunsTotal, scheduledJobSkippedTotal } from "./metrics.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type SkipReason = "lock_held" | "recently_run";

export type JobRunResult<T> =
  | { status: "executed"; result: T; runId: string }
  | { status: "skipped"; reason: SkipReason };

export type JobRunStatus = "running" | "succeeded" | "failed" | "abandoned";

export interface JobRunRecord {
  id: string;
  jobName: string;
  instanceId: string;
  status: JobRunStatus;
  startedAt: Date;
  finishedAt?: Date | null;
  durationMs?: number | null;
  error?: string | null;
}

/** A held lock. Releasing is idempotent. */
export interface AdvisoryLockHandle {
  release(): Promise<void>;
  /** True once the database session holding the lock was lost (crash, timeout). */
  readonly lost: boolean;
}

export interface AdvisoryLockBackend {
  /** Try to take the lock without waiting. Resolves `null` when another session holds it. */
  tryAcquire(lockKey: string, options?: { maxHoldMs?: number }): Promise<AdvisoryLockHandle | null>;
}

/** Persistence for run records; all calls happen while the job's lock is held. */
export interface JobRunStore {
  /** Mark `running` rows of this job as `abandoned` (their holder must be dead). */
  abandonRunning(jobName: string, now: Date): Promise<number>;
  /** Most recent run that actually executed to completion (succeeded or failed). */
  findLastCompleted(jobName: string): Promise<JobRunRecord | null>;
  start(run: { jobName: string; instanceId: string; startedAt: Date }): Promise<JobRunRecord>;
  finish(
    id: string,
    patch: { status: "succeeded" | "failed"; finishedAt: Date; durationMs: number; error?: string }
  ): Promise<void>;
}

export interface JobRunOptions {
  /**
   * Skip the tick when the job already completed within this many ms. Set it
   * to roughly half the job's cadence; it must exceed clock skew between
   * instances. Default 30s.
   */
  minIntervalMs?: number;
  /** Upper bound on how long the lock is held (the lock transaction's timeout). Default 30 min. */
  maxHoldMs?: number;
}

export interface JobLeaderElectionDeps {
  backend: AdvisoryLockBackend;
  runs: JobRunStore;
  instanceId?: string;
  now?: () => Date;
}

export const DEFAULT_MIN_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_HOLD_MS = 30 * 60_000;

// ── Lock keys & instance identity ────────────────────────────────────────────

/** Stable signed 64-bit advisory-lock key for a job name (as a decimal string). */
export function advisoryLockKey(jobName: string): string {
  const digest = createHash("sha256").update(`remitmortgage:scheduled-job:${jobName}`).digest();
  return BigInt.asIntN(64, digest.readBigUInt64BE(0)).toString();
}

/** `INSTANCE_ID` if set, otherwise hostname + pid + a random suffix. */
export function resolveInstanceId(env: NodeJS.ProcessEnv = process.env): string {
  return env.INSTANCE_ID?.trim() || `${os.hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
}

// ── Leader election ──────────────────────────────────────────────────────────

export interface JobLeaderElection {
  readonly instanceId: string;
  /**
   * Run `job` if this instance wins leadership for the tick. Rethrows the
   * job's error (after recording it); a skipped run resolves, never throws.
   */
  run<T>(jobName: string, job: () => Promise<T>, options?: JobRunOptions): Promise<JobRunResult<T>>;
}

export function createJobLeaderElection(deps: JobLeaderElectionDeps): JobLeaderElection {
  const instanceId = deps.instanceId ?? resolveInstanceId();
  const now = deps.now ?? (() => new Date());

  const skip = (jobName: string, reason: SkipReason): JobRunResult<never> => {
    scheduledJobSkippedTotal.inc({ job: jobName, reason });
    scheduledJobRunsTotal.inc({ job: jobName, outcome: `skipped_${reason}` });
    logger.info("[JobLeaderElection] Skipped scheduled run; another instance is the leader", {
      job: jobName,
      reason,
      instanceId,
    });
    return { status: "skipped", reason };
  };

  return {
    instanceId,

    async run<T>(jobName: string, job: () => Promise<T>, options: JobRunOptions = {}): Promise<JobRunResult<T>> {
      const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
      const maxHoldMs = options.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;

      const handle = await deps.backend.tryAcquire(advisoryLockKey(jobName), { maxHoldMs });
      if (!handle) return skip(jobName, "lock_held");

      try {
        // We hold the lock, so any `running` row belongs to a dead holder.
        const abandoned = await deps.runs.abandonRunning(jobName, now());
        if (abandoned > 0) {
          logger.warn("[JobLeaderElection] Previous holder died mid-run; taking over", {
            job: jobName,
            abandonedRuns: abandoned,
            instanceId,
          });
        }

        const last = await deps.runs.findLastCompleted(jobName);
        if (last && now().getTime() - last.startedAt.getTime() < minIntervalMs) {
          return skip(jobName, "recently_run");
        }

        const startedAt = now();
        const run = await deps.runs.start({ jobName, instanceId, startedAt });
        try {
          const result = await job();
          await deps.runs.finish(run.id, {
            status: "succeeded",
            finishedAt: now(),
            durationMs: now().getTime() - startedAt.getTime(),
          });
          scheduledJobRunsTotal.inc({ job: jobName, outcome: "executed" });
          if (handle.lost) {
            logger.warn("[JobLeaderElection] Lock was lost while the job ran; a second instance may have overlapped", {
              job: jobName,
              instanceId,
            });
          }
          return { status: "executed", result, runId: run.id };
        } catch (error) {
          await deps.runs
            .finish(run.id, {
              status: "failed",
              finishedAt: now(),
              durationMs: now().getTime() - startedAt.getTime(),
              error: error instanceof Error ? error.message : String(error),
            })
            .catch((recordError) =>
              logger.error("[JobLeaderElection] Could not record failed run", { job: jobName, recordError })
            );
          scheduledJobRunsTotal.inc({ job: jobName, outcome: "failed" });
          throw error;
        }
      } finally {
        await handle
          .release()
          .catch((error) => logger.error("[JobLeaderElection] Lock release failed", { job: jobName, error }));
      }
    },
  };
}

// ── PostgreSQL backend ───────────────────────────────────────────────────────

/** The slice of the Prisma client the backends use (kept structural for tests). */
export interface LockPrisma {
  $transaction<R>(
    fn: (tx: { $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> }) => Promise<R>,
    options?: { maxWait?: number; timeout?: number }
  ): Promise<R>;
}

/**
 * Advisory locks via an open interactive transaction.
 *
 * `pg_try_advisory_xact_lock` is bound to the transaction, so the lock lives
 * exactly as long as that transaction's connection: committing releases it,
 * and a crashed process (dead connection) makes PostgreSQL roll back and
 * release it. The job itself runs outside the transaction on its own pooled
 * connections; the lock transaction only idles.
 */
export function createPrismaAdvisoryLockBackend(prisma: LockPrisma): AdvisoryLockBackend {
  return {
    tryAcquire(lockKey, options = {}) {
      return new Promise<AdvisoryLockHandle | null>((resolve, reject) => {
        let lost = false;
        let acquired = false;
        let signalRelease!: () => void;
        const released = new Promise<void>((done) => {
          signalRelease = done;
        });
        let finished!: Promise<unknown>;

        const handle: AdvisoryLockHandle = {
          get lost() {
            return lost;
          },
          async release() {
            signalRelease();
            await finished.catch(() => undefined);
          },
        };

        finished = prisma
          .$transaction(
            async (tx) => {
              const rows = (await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${lockKey}::bigint) AS locked`) as Array<{
                locked: boolean;
              }>;
              if (!rows[0]?.locked) {
                resolve(null);
                return;
              }
              acquired = true;
              resolve(handle);
              await released;
            },
            { maxWait: 5_000, timeout: options.maxHoldMs ?? DEFAULT_MAX_HOLD_MS }
          )
          .catch((error) => {
            if (!acquired) {
              reject(error);
              return;
            }
            // The lock transaction died while the job was running (timeout or
            // lost connection): PostgreSQL has already released the lock.
            lost = true;
            logger.warn("[JobLeaderElection] Lock transaction ended unexpectedly", { error });
          });
      });
    },
  };
}

// ── Prisma run store ─────────────────────────────────────────────────────────

export function createPrismaJobRunStore(prisma: any): JobRunStore {
  return {
    async abandonRunning(jobName, now) {
      const { count } = await prisma.scheduledJobRun.updateMany({
        where: { jobName, status: "running" },
        data: { status: "abandoned", finishedAt: now },
      });
      return count;
    },
    async findLastCompleted(jobName) {
      return prisma.scheduledJobRun.findFirst({
        where: { jobName, status: { in: ["succeeded", "failed"] } },
        orderBy: { startedAt: "desc" },
      });
    },
    async start({ jobName, instanceId, startedAt }) {
      return prisma.scheduledJobRun.create({
        data: { jobName, instanceId, startedAt, status: "running" },
      });
    },
    async finish(id, patch) {
      await prisma.scheduledJobRun.update({
        where: { id },
        data: {
          status: patch.status,
          finishedAt: patch.finishedAt,
          durationMs: patch.durationMs,
          error: patch.error?.slice(0, 1000),
        },
      });
    },
  };
}

// ── Scheduler helper ─────────────────────────────────────────────────────────

let defaultElection: JobLeaderElection | null = null;

/** Process-wide election bound to the shared Prisma client (created on first use). */
export async function getJobLeaderElection(): Promise<JobLeaderElection> {
  if (!defaultElection) {
    const { prisma } = await import("./db.js");
    defaultElection = createJobLeaderElection({
      backend: createPrismaAdvisoryLockBackend(prisma),
      runs: createPrismaJobRunStore(prisma),
    });
  }
  return defaultElection;
}

/** Test hook: drop the cached default election. */
export function _resetJobLeaderElection(): void {
  defaultElection = null;
}

/**
 * Wrap a cron callback so only one instance runs each scheduled tick, and
 * skipped runs are counted. The returned function never rejects (cron
 * callbacks must not), and fails closed: if leadership cannot be determined
 * (e.g. the database is unreachable) the tick is not run.
 *
 *   cron.schedule("0 * * * *", scheduledJob("rate-limit-audit", runRateLimitAuditJob));
 */
export function scheduledJob(
  jobName: string,
  job: () => Promise<unknown> | unknown,
  options: JobRunOptions = {},
  election?: JobLeaderElection
): () => Promise<void> {
  return async () => {
    let jobFailed = false;
    try {
      const leaderElection = election ?? (await getJobLeaderElection());
      await leaderElection.run(
        jobName,
        async () => {
          try {
            return await job();
          } catch (error) {
            jobFailed = true;
            throw error;
          }
        },
        { minIntervalMs: Number(process.env.SCHEDULED_JOB_MIN_INTERVAL_MS) || undefined, ...options }
      );
    } catch (error) {
      // Job failures are already counted by `run`; this covers leadership errors.
      if (!jobFailed) scheduledJobRunsTotal.inc({ job: jobName, outcome: "leadership_error" });
      logger.error("[JobLeaderElection] Scheduled job did not complete", {
        job: jobName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
