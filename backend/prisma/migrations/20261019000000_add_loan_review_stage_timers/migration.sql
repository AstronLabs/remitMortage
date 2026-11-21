-- Service-level timers for loan review stages.
--
-- Records the moment an application enters a review stage (enteredAt) and the
-- moment it leaves (leftAt). Closed intervals feed the per-stage duration
-- summary; the open interval (leftAt IS NULL) is what the stuck-application
-- alert watches. alertSentAt dedupes that alert per interval.

CREATE TABLE "LoanReviewStageTimer" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "stage" "LoanStatus" NOT NULL,
  "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leftAt" TIMESTAMP(3),
  "alertSentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoanReviewStageTimer_pkey" PRIMARY KEY ("id")
);

-- One application's intervals, in order.
CREATE INDEX "LoanReviewStageTimer_applicationId_enteredAt_idx"
  ON "LoanReviewStageTimer"("applicationId", "enteredAt");

-- Summary scan: filter by stage then range on enteredAt.
CREATE INDEX "LoanReviewStageTimer_stage_enteredAt_idx"
  ON "LoanReviewStageTimer"("stage", "enteredAt");

-- Stuck-application scan: intervals that are still open.
CREATE INDEX "LoanReviewStageTimer_leftAt_idx"
  ON "LoanReviewStageTimer"("leftAt");

ALTER TABLE "LoanReviewStageTimer"
  ADD CONSTRAINT "LoanReviewStageTimer_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "LoanApplication"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
