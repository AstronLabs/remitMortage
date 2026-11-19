// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Transactional outbox for reliable business-event publishing (issue #858).
 *
 * The problem this solves: writing a business row and publishing to the queue
 * are two separate steps. If the process dies after the database commit but
 * before the publish, the event is lost and downstream systems drift.
 *
 * The fix: the producer inserts an `OutboxEvent` row in the *same* database
 * transaction as the business change. A relay worker repeatedly publishes
 * pending rows and marks them sent. Delivery is therefore at-least-once:
 *
 *   - a crash before publish leaves the row pending and the next pass sends it;
 *   - a crash after publish but before the `publishedAt` update causes a
 *     redelivery, which is safe because every row carries a stable
 *     `idempotencyKey` that consumers use to deduplicate.
 *
 * Rows that have been published are deleted by `cleanupPublishedOutboxEvents`
 * on a schedule so the table does not grow without bound.
 */

import { prisma } from "./db.js";
import logger from "../utils/logger.js";

/** Default number of rows a single relay pass will publish. */
export const DEFAULT_OUTBOX_BATCH_SIZE = 100;

/** Default retention for already-published rows. */
export const DEFAULT_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface OutboxEventInput {
  /**
   * Stable deduplication key for the logical event. Must be deterministic for
   * the same business change (e.g. `loan.approved:<loanId>`), so a duplicate
   * producer call and a relay redelivery both collapse to one effect.
   */
  idempotencyKey: string;
  /** Logical event name routed by consumers (e.g. `loan.approved`). */
  topic: string;
  /** JSON-serialisable event body. */
  payload: unknown;
  /** When the business change happened. Defaults to now. */
  occurredAt?: Date;
}

export interface OutboxRow {
  id: bigint | number | string;
  idempotencyKey: string;
  topic: string;
  payload: unknown;
  occurredAt: Date;
  createdAt: Date;
  publishedAt: Date | null;
  attempts: number;
  lastError: string | null;
}

export type OutboxPublisher = (event: {
  idempotencyKey: string;
  topic: string;
  payload: unknown;
  occurredAt: Date;
}) => Promise<void>;

/**
 * The write surface an outbox producer needs. It is intentionally loose so a
 * Prisma `TransactionClient` can be passed without a cast.
 */
export interface OutboxWriter {
  outboxEvent: {
    create(args: any): Promise<unknown>;
  };
}

/**
 * Minimal slice of the Prisma client the outbox needs. Taking it as a
 * parameter lets producers pass their transaction client and lets tests use a
 * deterministic in-memory double.
 */
export interface OutboxDb {
  outboxEvent: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy: Record<string, unknown>;
      take: number;
    }): Promise<OutboxRow[]>;
    update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
}

/** The shared Prisma client, typed as the outbox slice. */
export function defaultOutboxDb(): OutboxDb {
  return prisma as unknown as OutboxDb;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "P2002"
  );
}

/**
 * Insert an outbox row.
 *
 * IMPORTANT: call this with the **transaction client** that is writing the
 * business change, so both commit or roll back together:
 *
 * ```ts
 * await prisma.$transaction(async (tx) => {
 *   const loan = await tx.loanApplication.update(...);
 *   await enqueueOutboxEvent(tx, {
 *     idempotencyKey: `loan.approved:${loan.id}`,
 *     topic: "loan.approved",
 *     payload: { loanId: loan.id, status: loan.status },
 *   });
 * });
 * ```
 *
 * A duplicate `idempotencyKey` (e.g. a retried request or a replayed
 * transaction) is a no-op rather than an error, so producers do not have to
 * pre-check existence under concurrency.
 */
export async function enqueueOutboxEvent(
  tx: OutboxWriter,
  event: OutboxEventInput
): Promise<void> {
  const occurredAt = event.occurredAt ?? new Date();
  try {
    await tx.outboxEvent.create({
      data: {
        idempotencyKey: event.idempotencyKey,
        topic: event.topic,
        payload: event.payload,
        occurredAt,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      logger.debug("[outbox] duplicate idempotency key ignored", {
        idempotencyKey: event.idempotencyKey,
      });
      return;
    }
    throw error;
  }
}

export interface RelayOptions {
  db?: OutboxDb;
  batchSize?: number;
  now?: () => Date;
}

export interface RelayResult {
  published: number;
  failed: number;
  scanned: number;
}

/**
 * Publish one batch of pending rows, oldest first.
 *
 * Each row is marked published only after `publisher` resolves. If the
 * publisher throws (queue unreachable) the row stays pending and its attempt
 * counter and `lastError` are updated; the next pass retries it. This is the
 * at-least-once guarantee.
 */
export async function publishPendingOutboxEvents(
  publisher: OutboxPublisher,
  options: RelayOptions = {}
): Promise<RelayResult> {
  const db = options.db ?? defaultOutboxDb();
  const batchSize = options.batchSize ?? DEFAULT_OUTBOX_BATCH_SIZE;
  const now = options.now ?? (() => new Date());

  const rows = await db.outboxEvent.findMany({
    where: { publishedAt: null },
    orderBy: { id: "asc" },
    take: batchSize,
  });

  let published = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await publisher({
        idempotencyKey: row.idempotencyKey,
        topic: row.topic,
        payload: row.payload,
        occurredAt: row.occurredAt,
      });
      // A concurrent relay may have marked the same row; either way it is now
      // published, so it counts once in this pass.
      await db.outboxEvent.updateMany({
        where: { id: row.id, publishedAt: null },
        data: { publishedAt: now(), lastError: null },
      });
      published += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[outbox] publish failed; row stays pending", {
        id: String(row.id),
        idempotencyKey: row.idempotencyKey,
        error: message,
      });
      await db.outboxEvent.update({
        where: { id: row.id },
        data: {
          attempts: { increment: 1 },
          lastError: message.slice(0, 1000),
        },
      });
    }
  }

  return { published, failed, scanned: rows.length };
}

export interface CleanupOptions {
  db?: OutboxDb;
  retentionMs?: number;
  now?: () => Date;
}

/**
 * Delete rows published longer ago than `retentionMs`. Pending rows are never
 * touched, so a cleanup run can never drop an undelivered event.
 */
export async function cleanupPublishedOutboxEvents(
  options: CleanupOptions = {}
): Promise<{ deleted: number }> {
  const db = options.db ?? defaultOutboxDb();
  const retentionMs = options.retentionMs ?? DEFAULT_OUTBOX_RETENTION_MS;
  const now = (options.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - retentionMs);

  const result = await db.outboxEvent.deleteMany({
    where: { publishedAt: { lt: cutoff } },
  });
  return { deleted: result.count };
}
