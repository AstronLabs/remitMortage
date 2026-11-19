-- Issue #858: transactional outbox for reliable event publishing.
--
-- Business events are inserted into this table in the SAME transaction as the
-- business change. A relay worker then publishes pending rows and stamps
-- `publishedAt`. If the process dies between commit and publish, the row is
-- still pending and the next relay pass publishes it (at-least-once delivery).
--
-- `idempotencyKey` is stable per logical event, so consumers (and a relay that
-- republishes after a failed acknowledgement) can deduplicate.
CREATE TABLE "OutboxEvent" (
  "id"             BIGSERIAL PRIMARY KEY,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "topic"          TEXT NOT NULL,
  "payload"        JSONB NOT NULL,
  "occurredAt"     TIMESTAMPTZ(6) NOT NULL,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt"    TIMESTAMPTZ(6),
  "attempts"       INTEGER NOT NULL DEFAULT 0,
  "lastError"      TEXT
);

-- Relay worklist: oldest unsent rows first.
CREATE INDEX "OutboxEvent_pending_id_idx"
  ON "OutboxEvent" ("id") WHERE "publishedAt" IS NULL;

-- Retention/cleanup scans by publication time.
CREATE INDEX "OutboxEvent_published_createdAt_idx"
  ON "OutboxEvent" ("createdAt") WHERE "publishedAt" IS NOT NULL;

-- Lightweight lag surface for monitoring: how much is pending and how old the
-- oldest unsent row is, in seconds.
CREATE VIEW "OutboxEventLag" AS
SELECT COUNT(*)::BIGINT AS "pendingCount",
       COALESCE(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MIN("createdAt")))::BIGINT, 0) AS "oldestPendingSeconds"
  FROM "OutboxEvent"
 WHERE "publishedAt" IS NULL;
