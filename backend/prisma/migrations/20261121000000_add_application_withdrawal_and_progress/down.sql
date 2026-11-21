-- Postgres cannot drop an enum value; 'Withdrawn' stays on "LoanStatus".
DROP TABLE IF EXISTS "ApplicationProgress";
ALTER TABLE "LoanApplication" DROP COLUMN IF EXISTS "withdrawalReason";
ALTER TABLE "LoanApplication" DROP COLUMN IF EXISTS "withdrawnAt";
