-- Issue #813: metadata forgery analysis of uploaded ID documents. Flagged
-- documents go to manual review with the specific triggering signals.

CREATE TABLE "KycDocumentForensics" (
  "id" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "applicantAddress" TEXT NOT NULL,
  "format" TEXT NOT NULL,
  "flagged" BOOLEAN NOT NULL,
  "signals" JSONB NOT NULL,
  "analyzedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "reviewedBy" TEXT,
  "reviewOutcome" TEXT,
  "reviewNote" TEXT,
  CONSTRAINT "KycDocumentForensics_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KycDocumentForensics_documentId_key" ON "KycDocumentForensics"("documentId");
CREATE INDEX "KycDocumentForensics_flagged_reviewedAt_idx" ON "KycDocumentForensics"("flagged", "reviewedAt");
CREATE INDEX "KycDocumentForensics_applicantAddress_idx" ON "KycDocumentForensics"("applicantAddress");
