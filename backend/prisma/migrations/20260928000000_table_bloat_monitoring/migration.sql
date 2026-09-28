-- Issue #684: automated table bloat monitoring and VACUUM scheduling.
-- Stores periodic dead-tuple snapshots (from pg_stat_user_tables) per table
-- so operators can see which tables are bloating between autovacuum cycles.

CREATE TABLE "TableBloatSnapshot" (
  "id" TEXT NOT NULL,
  "schemaName" TEXT NOT NULL DEFAULT 'public',
  "tableName" TEXT NOT NULL,
  "liveTuples" BIGINT NOT NULL,
  "deadTuples" BIGINT NOT NULL,
  "deadTupleRatio" DOUBLE PRECISION NOT NULL,
  "tableSizeBytes" BIGINT NOT NULL,
  "lastAutovacuum" TIMESTAMP(3),
  "lastVacuum" TIMESTAMP(3),
  "vacuumTriggered" BOOLEAN NOT NULL DEFAULT false,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TableBloatSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TableBloatSnapshot_capturedAt_idx" ON "TableBloatSnapshot"("capturedAt");
CREATE INDEX "TableBloatSnapshot_tableName_capturedAt_idx" ON "TableBloatSnapshot"("tableName", "capturedAt");
