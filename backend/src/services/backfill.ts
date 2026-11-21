// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import sharedLogger from "../utils/logger.js";

/**
 * Minimal resumable backfill framework.
 *
 * A backfill is described by a {@link BackfillDefinition}: how to fetch one
 * batch at a time and how to apply it. {@link runBackfill} drives the loop,
 * persists the last completed batch's cursor through a {@link BackfillStore} and
 * emits structured progress logs (including an estimate of the batches
 * remaining) after every batch.
 *
 * Crash safety: the checkpoint is written only *after* a batch has been fully
 * applied, so an interrupted run resumes from the last completed batch (the
 * in-flight batch is replayed) instead of starting over.
 */

/** Structured logger used for progress reporting. */
export interface BackfillLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** A single unit of work plus the cursor that marks it complete. */
export interface BackfillBatch<TItem, TCursor = string | null> {
  /** Items produced by this batch, in processing order. */
  items: TItem[];
  /** Cursor persisted as the resume point once this batch completes. */
  cursor: TCursor;
  /** Set to `true` on the final batch of the run. */
  done?: boolean;
}

/** Snapshot of a run's progress, passed to {@link BackfillDefinition.estimateTotalBatches}. */
export interface BackfillProgress {
  /** True when the run resumed from a previously saved checkpoint. */
  resumed: boolean;
  /** Batches completed so far, including the current one. */
  completedBatches: number;
  /** Items processed so far. */
  processed: number;
}

/** Describes the work a backfill performs. */
export interface BackfillDefinition<TItem, TCursor = string | null> {
  /** Stable name used in log messages. */
  name: string;
  /** Fetch the next batch to process, continuing after `cursor`. */
  fetchBatch(cursor: TCursor): Promise<BackfillBatch<TItem, TCursor>>;
  /** Apply a fully fetched batch. Should be safe to replay after a crash. */
  processBatch(items: TItem[]): Promise<void>;
  /** Extra context (e.g. the row/ledger range) merged into the run's start log. */
  describeStart?(): Record<string, unknown>;
  /**
   * Optional estimate of the total number of batches, used to report how many
   * batches remain. Return `undefined` when the total cannot be estimated.
   */
  estimateTotalBatches?(progress: BackfillProgress): number | undefined;
}

/** Persists the resume point between runs. */
export interface BackfillStore<TCursor = string | null> {
  /** Load the last saved cursor, or `null` when there is no checkpoint yet. */
  load(): Promise<TCursor | null>;
  /** Persist the cursor of the last fully completed batch. */
  save(cursor: TCursor, processed: number): Promise<void>;
}

/** Outcome of a {@link runBackfill} call. */
export interface BackfillSummary {
  /** True when the run resumed from a saved checkpoint. */
  resumed: boolean;
  /** Number of batches completed during this run. */
  batches: number;
  /** Number of items processed during this run. */
  processed: number;
}

const defaultLogger: BackfillLogger = {
  info: (message, meta) => sharedLogger.info(message, meta),
  warn: (message, meta) => sharedLogger.warn(message, meta),
  error: (message, meta) => sharedLogger.error(message, meta),
};

/** Renders any cursor value into something safe to attach to a log line. */
function describeCursor(cursor: unknown): unknown {
  if (cursor === null || cursor === undefined) {
    return null;
  }
  if (typeof cursor !== "object") {
    return cursor;
  }
  return JSON.stringify(cursor);
}

/**
 * Runs `definition` to completion in batches, checkpointing after each batch so
 * a later run resumes from the last completed batch's cursor.
 */
export async function runBackfill<TItem, TCursor = string | null>(
  definition: BackfillDefinition<TItem, TCursor>,
  store: BackfillStore<TCursor>,
  initialCursor: TCursor,
  progressLogger: BackfillLogger = defaultLogger
): Promise<BackfillSummary> {
  const checkpoint = await store.load();
  const resumed = checkpoint !== null;
  let cursor = resumed ? (checkpoint as TCursor) : initialCursor;
  let completedBatches = 0;
  let processed = 0;

  progressLogger.info(`[${definition.name}] starting`, {
    resumed,
    ...(definition.describeStart?.() ?? {}),
  });

  for (;;) {
    const batch = await definition.fetchBatch(cursor);
    await definition.processBatch(batch.items);

    processed += batch.items.length;
    completedBatches += 1;
    cursor = batch.cursor;

    // Persist only once the batch has been fully applied, so a crash replays
    // the in-flight batch rather than skipping past it.
    await store.save(cursor, processed);

    const progress: BackfillProgress = { resumed, completedBatches, processed };
    const estimatedTotalBatches = definition.estimateTotalBatches?.(progress);
    const batchesRemaining =
      estimatedTotalBatches === undefined
        ? undefined
        : Math.max(estimatedTotalBatches - completedBatches, 0);

    progressLogger.info(`[${definition.name}] batch completed`, {
      completedBatches,
      processed,
      batchSize: batch.items.length,
      batchesRemaining,
      estimatedTotalBatches,
      cursor: describeCursor(cursor),
    });

    if (batch.done) {
      break;
    }
  }

  progressLogger.info(`[${definition.name}] completed`, {
    resumed,
    batches: completedBatches,
    processed,
  });

  return { resumed, batches: completedBatches, processed };
}
