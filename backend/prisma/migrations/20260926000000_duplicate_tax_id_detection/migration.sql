-- Issue #692: duplicate applicant SSN/tax ID detection at onboarding.
-- Applicant.taxId is encrypted with a random IV, so equal tax IDs never
-- produce equal stored values. taxIdHash holds a keyed HMAC of the normalized
-- tax ID so matches can be found by index without storing plaintext.

ALTER TABLE "Applicant" ADD COLUMN "taxIdHash" TEXT;
CREATE INDEX "Applicant_taxIdHash_idx" ON "Applicant"("taxIdHash");

ALTER TABLE "LoanApplication" ADD COLUMN "manualReviewReason" TEXT;
