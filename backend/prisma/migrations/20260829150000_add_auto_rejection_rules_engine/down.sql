-- Rollback for 20260829150000_add_auto_rejection_rules_engine.
ALTER TABLE IF EXISTS "LoanAutoRejectionLog"
  DROP CONSTRAINT IF EXISTS "LoanAutoRejectionLog_ruleId_fkey";
ALTER TABLE IF EXISTS "LoanAutoRejectionLog"
  DROP CONSTRAINT IF EXISTS "LoanAutoRejectionLog_applicationId_fkey";

DROP TABLE IF EXISTS "LoanAutoRejectionLog";
DROP TABLE IF EXISTS "LoanAutoRejectionRule";

ALTER TABLE "LoanApplication" DROP COLUMN IF EXISTS "autoRejectedAt";
ALTER TABLE "LoanApplication" DROP COLUMN IF EXISTS "reason";

DROP TYPE IF EXISTS "AutoRejectionRuleType";
