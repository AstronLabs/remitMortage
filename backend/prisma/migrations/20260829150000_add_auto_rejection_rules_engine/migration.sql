-- Auto-rejection rules engine: configurable eligibility rules and audit logs.

CREATE TYPE "AutoRejectionRuleType" AS ENUM (
  'MIN_CREDIT_SCORE',
  'MAX_DEBT_TO_INCOME',
  'REQUIRES_VERIFICATION'
);

ALTER TABLE "LoanApplication"
  ADD COLUMN IF NOT EXISTS "reason" TEXT,
  ADD COLUMN IF NOT EXISTS "autoRejectedAt" TIMESTAMP(3);

CREATE TABLE "LoanAutoRejectionRule" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "ruleType" "AutoRejectionRuleType" NOT NULL,
  "config" JSONB NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "LoanAutoRejectionRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LoanAutoRejectionLog" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "ruleId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LoanAutoRejectionLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LoanAutoRejectionRule_active_priority_idx"
  ON "LoanAutoRejectionRule"("active", "priority");

CREATE INDEX "LoanAutoRejectionLog_applicationId_idx"
  ON "LoanAutoRejectionLog"("applicationId");

CREATE INDEX "LoanAutoRejectionLog_ruleId_idx"
  ON "LoanAutoRejectionLog"("ruleId");

CREATE INDEX "LoanAutoRejectionLog_createdAt_idx"
  ON "LoanAutoRejectionLog"("createdAt");

ALTER TABLE "LoanAutoRejectionLog"
  ADD CONSTRAINT "LoanAutoRejectionLog_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "LoanApplication"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LoanAutoRejectionLog"
  ADD CONSTRAINT "LoanAutoRejectionLog_ruleId_fkey"
  FOREIGN KEY ("ruleId") REFERENCES "LoanAutoRejectionRule"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
