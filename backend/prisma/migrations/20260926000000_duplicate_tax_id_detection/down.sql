ALTER TABLE "LoanApplication" DROP COLUMN IF EXISTS "manualReviewReason";

DROP INDEX IF EXISTS "Applicant_taxIdHash_idx";
ALTER TABLE "Applicant" DROP COLUMN IF EXISTS "taxIdHash";
