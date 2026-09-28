-- Issue #746: interest rate sheet version history and audit trail.
-- Every rate sheet change is a new InterestRateSheetVersion row; a trigger
-- rejects UPDATE/DELETE so history can never be overwritten. New loan
-- applications record which version priced them in rateSheetVersionId.

CREATE TABLE "InterestRateSheetVersion" (
  "id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "effectiveAt" TIMESTAMP(3) NOT NULL,
  "rates" JSONB NOT NULL,
  "changedValues" JSONB NOT NULL,
  "changedBy" TEXT NOT NULL,
  "changeReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InterestRateSheetVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InterestRateSheetVersion_version_key" ON "InterestRateSheetVersion"("version");
CREATE INDEX "InterestRateSheetVersion_effectiveAt_idx" ON "InterestRateSheetVersion"("effectiveAt");

CREATE OR REPLACE FUNCTION prevent_rate_sheet_version_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'InterestRateSheetVersion is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_rate_sheet_version_append_only
  BEFORE UPDATE OR DELETE ON "InterestRateSheetVersion"
  FOR EACH ROW EXECUTE FUNCTION prevent_rate_sheet_version_mutation();

ALTER TABLE "LoanApplication" ADD COLUMN "rateSheetVersionId" TEXT;
CREATE INDEX "LoanApplication_rateSheetVersionId_idx" ON "LoanApplication"("rateSheetVersionId");
ALTER TABLE "LoanApplication"
  ADD CONSTRAINT "LoanApplication_rateSheetVersionId_fkey"
  FOREIGN KEY ("rateSheetVersionId") REFERENCES "InterestRateSheetVersion"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Baseline version 1: the flat 8% default that applications were priced at
-- before sheets were versioned. Existing applications keep a NULL reference
-- because they predate versioning; backfilling them would misstate history.
INSERT INTO "InterestRateSheetVersion"
  ("id", "version", "effectiveAt", "rates", "changedValues", "changedBy", "changeReason")
VALUES
  (gen_random_uuid()::text, 1, CURRENT_TIMESTAMP,
   '{"baseRateBps": 800}'::jsonb,
   '[{"path": "baseRateBps", "before": null, "after": 800}]'::jsonb,
   'system:migration',
   'Baseline: flat default rate in effect before rate sheet versioning');
