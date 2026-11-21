// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import type { Job, JobsOptions } from "bullmq";
import { prisma } from "./db.js";
import logger from "../utils/logger.js";

/**
 * Dead-letter queue for background jobs (issue #1103).
 *
 * BullMQ retries a failing job up to its configured `attempts` and then marks
 * it failed — where `removeOnFail` eventually evicts it, leaving the failure
 * visible only in logs. This module captures a job that has used up every
 * attempt into the `DeadLetterJob` table with its original payload and last
 * failure reason, and lets an admin list those jobs and requeue one, with the
 * payload intact, once the underlying issue is fixed.
 */

export type DeadLetterStatus = "dead" | "requeued";

export interface DeadLetterJobRecord {
  id: string;
  queueName: string;
  jobName: string;
  originalJobId: string | null;
  payload: unknown;
  failureReason: string;
  attemptsMade: number;
  status: DeadLetterStatus;
  failedAt: Date;
  requeuedAt: Date | null;
  requeuedBy: string | null;
  requeuedJobId: string | null;
}

/** The slice of the Prisma delegate this module uses, so tests can swap it. */
export interface DeadLetterStore {
  create(args: { data: Record<string, unknown> }): Promise<DeadLetterJobRecord>;
  findMany(args: Record<string, unknown>): Promise<DeadLetterJobRecord[]>;
  findUnique(args: { where: { id: string } }): Promise<DeadLetterJobRecord | null>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

/**
 * The `DeadLetterJob` delegate. Reached through a cast because the generated
 * Prisma client may predate the model (the same pattern apiKeyQuota.ts uses
 * for new models); the migration ships the table and the client is
 * regenerated on install.
 */
function defaultStore(): DeadLetterStore {
  return (prisma as any).deadLetterJob as DeadLetterStore;
}

/** The minimum a queue must offer for a dead-lettered job to be requeued onto it. */
export interface RequeueTarget {
  add(name: string, data: unknown, opts?: JobsOptions): Promise<{ id?: string | null } | undefined>;
}

export type QueueResolver = (queueName: string) => RequeueTarget | undefined;

export class DeadLetterJobNotFoundError extends Error {
  readonly code = "not_found" as const;
  constructor(id: string) {
    super(`Dead-lettered job ${id} not found`);
    this.name = "DeadLetterJobNotFoundError";
  }
}

export class DeadLetterJobStateError extends Error {
  readonly code = "already_requeued" as const;
  constructor(id: string) {
    super(`Dead-lettered job ${id} has already been requeued`);
    this.name = "DeadLetterJobStateError";
  }
}

export class DeadLetterQueueUnavailableError extends Error {
  readonly code = "queue_unavailable" as const;
  constructor(queueName: string) {
    super(`Queue ${queueName} is not available to requeue onto`);
    this.name = "DeadLetterQueueUnavailableError";
  }
}

/**
 * True once a failed job has no attempts left. BullMQ has already counted the
 * failing attempt in `attemptsMade` by the time the worker's `failed` event
 * fires; a job enqueued without `attempts` gets exactly one.
 */
export function hasExhaustedRetries(job: Pick<Job, "attemptsMade" | "opts">): boolean {
  const allowed = Math.max(1, job.opts?.attempts ?? 1);
  return job.attemptsMade >= allowed;
}

/**
 * Moves `job` into the dead-letter queue if it has exhausted its retries.
 * Returns the stored record, or null when the job still has retries left
 * (BullMQ will run it again). Never throws: a failure to dead-letter is
 * logged loudly but must not crash the worker's event loop.
 */
export async function captureExhaustedJob(
  queueName: string,
  job: Pick<Job, "id" | "name" | "data" | "attemptsMade" | "opts">,
  error: unknown,
  store: DeadLetterStore = defaultStore()
): Promise<DeadLetterJobRecord | null> {
  if (!hasExhaustedRetries(job)) return null;

  const failureReason =
    error instanceof Error ? error.message || error.name : String(error ?? "unknown error");

  try {
    const record = await store.create({
      data: {
        queueName,
        jobName: job.name,
        originalJobId: job.id ?? null,
        // The payload is stored exactly as enqueued so a requeue replays it unchanged.
        payload: job.data as unknown,
        failureReason,
        attemptsMade: job.attemptsMade,
        status: "dead",
      },
    });
    logger.error("[dead-letter] job exhausted its retries and was dead-lettered", {
      queueName,
      jobName: job.name,
      jobId: job.id,
      deadLetterId: record.id,
      attemptsMade: job.attemptsMade,
      failureReason,
    });
    return record;
  } catch (captureError) {
    logger.error("[dead-letter] failed to record exhausted job", {
      queueName,
      jobName: job.name,
      jobId: job.id,
      failureReason,
      error: captureError instanceof Error ? captureError.message : String(captureError),
    });
    return null;
  }
}

/**
 * Hooks a BullMQ worker's `failed` event so every job that exhausts its
 * retries on `queueName` lands in the dead-letter queue.
 */
export function attachDeadLetterQueue(
  queueName: string,
  worker: { on(event: "failed", listener: (job: Job | undefined, err: Error) => void): unknown },
  store?: DeadLetterStore
): void {
  worker.on("failed", (job, err) => {
    if (!job) return;
    void captureExhaustedJob(queueName, job, err, store ?? defaultStore());
  });
}

export const DEFAULT_DEAD_LETTER_LIST_LIMIT = 50;
export const MAX_DEAD_LETTER_LIST_LIMIT = 200;

export interface ListDeadLetterJobsOptions {
  queueName?: string;
  status?: DeadLetterStatus;
  limit?: number;
}

/** Dead-lettered jobs, most recent failure first. Defaults to those still awaiting a requeue. */
export async function listDeadLetterJobs(
  options: ListDeadLetterJobsOptions = {},
  store: DeadLetterStore = defaultStore()
): Promise<DeadLetterJobRecord[]> {
  const limit = Math.min(
    MAX_DEAD_LETTER_LIST_LIMIT,
    Math.max(1, Math.floor(options.limit ?? DEFAULT_DEAD_LETTER_LIST_LIMIT))
  );
  return store.findMany({
    where: {
      status: options.status ?? "dead",
      ...(options.queueName ? { queueName: options.queueName } : {}),
    },
    orderBy: [{ failedAt: "desc" }, { id: "desc" }],
    take: limit,
  });
}

/**
 * Puts a dead-lettered job back on its original queue under its original
 * name with its original payload, then marks the record requeued. The new
 * job gets the queue's default retry policy, so if the problem persists it
 * will dead-letter again as a fresh record rather than vanish.
 *
 * The status flip is a conditional update on `status: "dead"`, so two admins
 * racing to requeue the same job can't both enqueue it.
 */
export async function requeueDeadLetterJob(
  id: string,
  options: { resolveQueue: QueueResolver; requeuedBy?: string; now?: Date },
  store: DeadLetterStore = defaultStore()
): Promise<DeadLetterJobRecord> {
  const record = await store.findUnique({ where: { id } });
  if (!record) throw new DeadLetterJobNotFoundError(id);
  if (record.status !== "dead") throw new DeadLetterJobStateError(id);

  const queue = options.resolveQueue(record.queueName);
  if (!queue) throw new DeadLetterQueueUnavailableError(record.queueName);

  const requeuedAt = options.now ?? new Date();
  const claimed = await store.updateMany({
    where: { id, status: "dead" },
    data: { status: "requeued", requeuedAt, requeuedBy: options.requeuedBy ?? null },
  });
  if (claimed.count === 0) throw new DeadLetterJobStateError(id);

  let job: { id?: string | null } | undefined;
  try {
    job = await queue.add(record.jobName, record.payload);
  } catch (error) {
    // Enqueue failed: release the claim so the job can be requeued again.
    await store.updateMany({
      where: { id, status: "requeued" },
      data: { status: "dead", requeuedAt: null, requeuedBy: null },
    });
    throw error;
  }
  if (!job) {
    await store.updateMany({
      where: { id, status: "requeued" },
      data: { status: "dead", requeuedAt: null, requeuedBy: null },
    });
    throw new DeadLetterQueueUnavailableError(record.queueName);
  }

  const requeuedJobId = job.id ?? null;
  await store.updateMany({ where: { id }, data: { requeuedJobId } });

  logger.info("[dead-letter] job requeued", {
    deadLetterId: id,
    queueName: record.queueName,
    jobName: record.jobName,
    requeuedJobId,
    requeuedBy: options.requeuedBy,
  });

  return {
    ...record,
    status: "requeued",
    requeuedAt,
    requeuedBy: options.requeuedBy ?? null,
    requeuedJobId,
  };
}
