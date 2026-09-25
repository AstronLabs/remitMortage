-- Rollback for 20260826000000_add_soft_delete_retention_fields.
DROP INDEX IF EXISTS "Applicant_deletedAt_idx";
DROP INDEX IF EXISTS "LoanApplication_deletedAt_idx";
DROP INDEX IF EXISTS "Borrower_deletedAt_idx";

ALTER TABLE "Applicant" DROP COLUMN IF EXISTS "deletedAt";
ALTER TABLE "LoanApplication" DROP COLUMN IF EXISTS "deletedAt";
ALTER TABLE "Borrower" DROP COLUMN IF EXISTS "deletedAt";
