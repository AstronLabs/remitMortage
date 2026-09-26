-- Issue #583: automated slow query logging + weekly digest.
-- Captures database operations whose duration exceeded the configurable
-- threshold. The weekly digest groups rows by `fingerprint` to rank the top
-- offending query patterns by frequency and average duration.

CREATE TABLE "SlowQueryLog" (
  "id" TEXT NOT NULL,
  "query" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "model" TEXT,
  "operation" TEXT,
  "durationMs" INTEGER NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SlowQueryLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SlowQueryLog_occurredAt_idx" ON "SlowQueryLog"("occurredAt");
CREATE INDEX "SlowQueryLog_fingerprint_idx" ON "SlowQueryLog"("fingerprint");
CREATE INDEX "SlowQueryLog_fingerprint_occurredAt_idx"
  ON "SlowQueryLog"("fingerprint", "occurredAt");
