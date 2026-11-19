-- Issue #935: record which application instance executed each scheduled job.
-- Written by services/jobLeaderElection.ts while the job's PostgreSQL advisory
-- lock is held, so rows for one job are never written concurrently.
CREATE TABLE "ScheduledJobRun" (
  "id" TEXT NOT NULL,
  "jobName" TEXT NOT NULL,
  "instanceId" TEXT NOT NULL,
  -- running | succeeded | failed | abandoned (holder died before finishing)
  "status" TEXT NOT NULL DEFAULT 'running',
  "startedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3),
  "durationMs" INTEGER,
  "error" TEXT,
  CONSTRAINT "ScheduledJobRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ScheduledJobRun_jobName_startedAt_idx"
  ON "ScheduledJobRun"("jobName", "startedAt" DESC);
CREATE INDEX "ScheduledJobRun_jobName_status_idx"
  ON "ScheduledJobRun"("jobName", "status");
