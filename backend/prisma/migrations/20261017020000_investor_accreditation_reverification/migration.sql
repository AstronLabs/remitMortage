-- Issue #725: periodic re-verification of accredited investor status.
CREATE TABLE "InvestorAccreditation" (
  "id" TEXT NOT NULL,
  "investorAddress" TEXT NOT NULL,
  "lastVerifiedAt" TIMESTAMP(3) NOT NULL,
  "reminderSentAt" TIMESTAMP(3),
  "missedReminderSentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InvestorAccreditation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InvestorAccreditation_investorAddress_key"
  ON "InvestorAccreditation"("investorAddress");
CREATE INDEX "InvestorAccreditation_lastVerifiedAt_idx"
  ON "InvestorAccreditation"("lastVerifiedAt");
