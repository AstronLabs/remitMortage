-- Dead-letter queue for background jobs that exhaust their retries (issue #1103).
--
-- A BullMQ job that fails its final attempt is copied here with its original
-- payload and last failure reason instead of being silently dropped, so an
-- admin can list it and requeue it once the underlying problem is fixed.

CREATE TABLE "DeadLetterJob" (
  "id" TEXT NOT NULL,
  "queueName" TEXT NOT NULL,
  "jobName" TEXT NOT NULL,
  "originalJobId" TEXT,
  "payload" JSONB NOT NULL,
  "failureReason" TEXT NOT NULL,
  "attemptsMade" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'dead',
  "failedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requeuedAt" TIMESTAMP(3),
  "requeuedBy" TEXT,
  "requeuedJobId" TEXT,
  CONSTRAINT "DeadLetterJob_pkey" PRIMARY KEY ("id")
);

-- migration-ok: indexes a table created empty in this same migration, so there is nothing to lock
CREATE INDEX "DeadLetterJob_status_failedAt_idx" ON "DeadLetterJob"("status", "failedAt");
-- migration-ok: indexes a table created empty in this same migration, so there is nothing to lock
CREATE INDEX "DeadLetterJob_queueName_status_idx" ON "DeadLetterJob"("queueName", "status");
