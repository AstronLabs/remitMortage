// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Relay and cleanup workers for the transactional outbox (issue #858).
 *
 * The relay publishes pending outbox rows to the existing Redis-backed ledger
 * event queue and marks them sent. `enqueueLedgerEvent` already carries an `id`
 * and every outbox row carries an `idempotencyKey`; the key is forwarded in the
 * published job so downstream consumers can deduplicate a redelivery.
 */

import {
  cleanupPublishedOutboxEvents,
  publishPendingOutboxEvents,
  type OutboxDb,
  type OutboxPublisher,
} from "../services/transactionalOutbox.js";
import { enqueueLedgerEvent, type LedgerEventJob } from "../services/eventProducer.js";
import logger from "../utils/logger.js";

/** Publish one outbox row to the Redis queue. Throws so the row retries. */
async function queuePublisher(event: {
  idempotencyKey: string;
  topic: string;
  payload: unknown;
  occurredAt: Date;
}): Promise<void> {
  const job = event.payload as LedgerEventJob;
  // The queue is the delivery target. A missing Redis connection is a
  // transient failure: leave the row pending so the next pass retries it.
  const queued = await enqueueLedgerEvent({
    ...job,
    // Never let a producer-supplied id override the stable idempotency key.
    id: event.idempotencyKey,
  });
  if (!queued) {
    throw new Error("ledger event queue unavailable");
  }
}

/** Run one relay pass. Returns the publish counters for logging/tests. */
export async function runOutboxRelayOnce(options: {
  db?: OutboxDb;
  publisher?: OutboxPublisher;
  batchSize?: number;
} = {}) {
  const result = await publishPendingOutboxEvents(
    options.publisher ?? queuePublisher,
    { db: options.db, batchSize: options.batchSize }
  );
  if (result.scanned > 0) {
    logger.info("[outbox-relay] pass complete", result);
  }
  return result;
}

/** Delete published rows older than the retention window. */
export async function runOutboxCleanupOnce(options: {
  db?: OutboxDb;
  retentionMs?: number;
} = {}) {
  const result = await cleanupPublishedOutboxEvents(options);
  if (result.deleted > 0) {
    logger.info("[outbox-relay] cleaned published rows", result);
  }
  return result;
}
