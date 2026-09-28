ALTER TABLE "LoanApplication" DROP CONSTRAINT IF EXISTS "LoanApplication_rateSheetVersionId_fkey";
DROP INDEX IF EXISTS "LoanApplication_rateSheetVersionId_idx";
ALTER TABLE "LoanApplication" DROP COLUMN IF EXISTS "rateSheetVersionId";
DROP TRIGGER IF EXISTS trg_rate_sheet_version_append_only ON "InterestRateSheetVersion";
DROP FUNCTION IF EXISTS prevent_rate_sheet_version_mutation();
DROP TABLE IF EXISTS "InterestRateSheetVersion";
