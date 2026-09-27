-- Issue #791: applicant mailing address, standardized/verified against a
-- postal provider (e.g. USPS) at entry time. An address the provider can't
-- validate is flagged for review, not silently accepted or rejected.

ALTER TABLE "Applicant"
  ADD COLUMN "addressLine1" TEXT,
  ADD COLUMN "addressLine2" TEXT,
  ADD COLUMN "addressCity" TEXT,
  ADD COLUMN "addressState" TEXT,
  ADD COLUMN "addressPostalCode" TEXT,
  ADD COLUMN "addressCountry" TEXT,
  ADD COLUMN "addressVerificationStatus" TEXT,
  ADD COLUMN "addressVerificationDetail" TEXT,
  ADD COLUMN "addressVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "addressProviderReference" TEXT;

CREATE INDEX "Applicant_addressVerificationStatus_idx" ON "Applicant"("addressVerificationStatus");
