// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { getRedisClient } from "./redis.js";
import logger from "../utils/logger.js";

/** Prefix for the ledger-event queue in Redis. */
const EVENT_QUEUE_KEY = "queue:ledger-events";
const EVENT_QUEUE_ATTEMPT_PREFIX = "queue:ledger-events:attempt:";
const EVENT_QUEUE_DLQ_KEY = "queue:ledger-events:dlq";
const MAX_RETRY_ATTEMPTS = 3;

export interface LedgerEventJob {
  /** Unique job identifier (deduplication key). */
  id: string;
  /** The contract event topic, e.g. "deposit", "disburse". */
  topic: string;
  /** Borrower Stellar address. */
  borrower: string;
  /** Event amount as a decimal string. */
  amount: string;
  /** Ledger sequence number. */
  ledger: number;
  /** Contract ID that emitted the event. */
  contractId: string;
  /** ISO timestamp when the job was created. */
  createdAt: string;
}

/**
 * Push a ledger event onto the Redis-backed asynchronous job queue.
 * Returns `true` if the event was queued, `false` if Redis is unavailable.
 */
export async function enqueueLedgerEvent(job: LedgerEventJob): Promise<boolean> {
  const client = getRedisClient();
  if (!client) {
    logger.warn("[event-producer] Redis unavailable; skipping enqueue");
    return false;
  }

  try {
    const payload = JSON.stringify(job);
    // Use LPUSH to push onto the list (left side)
    await client.lpush(EVENT_QUEUE_KEY, payload);
    logger.debug(`[event-producer] enqueued job ${job.id} topic=${job.topic}`);
    return true;
  } catch (err) {
    logger.error("[event-producer] failed to enqueue job", { error: err, jobId: job.id });
    return false;
  }
}

/**
 * Read the current attempt count for a job ID.
 */
async function getJobAttempts(client: import("ioredis").Redis, jobId: string): Promise<number> {
  const key = `${EVENT_QUEUE_ATTEMPT_PREFIX}${jobId}`;
  const val = await client.get(key);
  return val ? parseInt(val, 10) : 0;
}

/**
 * Increment the attempt count for a job ID.
 */
async function incrementJobAttempts(client: import("ioredis").Redis, jobId: string): Promise<number> {
  const key = `${EVENT_QUEUE_ATTEMPT_PREFIX}${jobId}`;
  const val = await client.incr(key);
  // Expire the attempt counter after 1 hour so we don't leak keys forever.
  await client.expire(key, 3600);
  return val;
}

/**
 * Move a failed job payload to the Dead Letter Queue.
 */
async function sendToDlq(client: import("ioredis").Redis, payload: string, reason: string): Promise<void> {
  const dlqEntry = JSON.stringify({
    payload,
    reason,
    failedAt: new Date().toISOString(),
  });
  await client.lpush(EVENT_QUEUE_DLQ_KEY, dlqEntry);
  logger.warn("[event-worker] job moved to DLQ", { reason });
}

export type JobHandler = (job: LedgerEventJob) => Promise<void>;

/**
 * Process one job from the event queue. Returns `true` if a job was processed,
 * `false` if the queue was empty.
 */
export async function processNextEvent(handler: JobHandler): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return false;

  // Blocking pop from the right side (oldest first), timeout 1s
  const result = await client.brpop(EVENT_QUEUE_KEY, 1);
  if (!result) return false;

  const [, payload] = result;
  let job: LedgerEventJob;
  try {
    job = JSON.parse(payload);
  } catch {
    logger.error("[event-worker] failed to parse job payload, sending to DLQ");
    await sendToDlq(client, payload, "parse_error");
    return true;
  }

  try {
    await handler(job);
    // Success — clean up attempt counter if any.
    const key = `${EVENT_QUEUE_ATTEMPT_PREFIX}${job.id}`;
    await client.del(key);
    return true;
  } catch (err) {
    const attempts = await incrementJobAttempts(client, job.id);
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[event-worker] job ${job.id} failed (attempt ${attempts}/${MAX_RETRY_ATTEMPTS})`, { error: message });

    if (attempts >= MAX_RETRY_ATTEMPTS) {
      // Max retries exceeded — move to DLQ.
      await sendToDlq(client, payload, `max_retries: ${message}`);
    } else {
      // Re-enqueue for retry (push back to right side).
      await client.rpush(EVENT_QUEUE_KEY, payload);
    }
    return true;
  }
}

/**
 * Drain the DLQ and return all entries for inspection / replay.
 */
export async function drainDlq(): Promise<Array<{ payload: string; reason: string; failedAt: string }>> {
  const client = getRedisClient();
  if (!client) return [];

  const entries: Array<{ payload: string; reason: string; failedAt: string }> = [];
  while (true) {
    const result = await client.brpop(EVENT_QUEUE_DLQ_KEY, 0);
    if (!result) break;
    const [, raw] = result;
    try {
      entries.push(JSON.parse(raw));
    } catch {
      entries.push({ payload: raw, reason: "corrupt_dlq_entry", failedAt: new Date().toISOString() });
    }
  }
  return entries;
}

/**
 * Returns the approximate queue depth (number of pending jobs).
 */
export async function getQueueDepth(): Promise<number> {
  const client = getRedisClient();
  if (!client) return 0;

  try {
    return await client.llen(EVENT_QUEUE_KEY);
  } catch {
    return 0;
  }
}

/**
 * Returns the approximate DLQ depth.
 */
export async function getDlqDepth(): Promise<number> {
  const client = getRedisClient();
  if (!client) return 0;

  try {
    return await client.llen(EVENT_QUEUE_DLQ_KEY);
  } catch {
    return 0;
  }
}
