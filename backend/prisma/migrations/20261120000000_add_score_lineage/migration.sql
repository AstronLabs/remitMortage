-- Data lineage for computed credit scores (issue #982).
--
-- One row per stored score, holding the exact inputs, model version and
-- timestamp used by calculateCreditScore, so the score can be recomputed
-- during a dispute. Independent of the score row so the lineage can be
-- deleted after its retention window without losing the verification result.

CREATE TABLE "ScoreLineage" (
  "id" TEXT NOT NULL,
  "verificationResultId" TEXT NOT NULL,
  "applicantId" TEXT NOT NULL,
  "inputs" JSONB NOT NULL,
  "score" INTEGER NOT NULL,
  "modelVersion" TEXT NOT NULL,
  "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScoreLineage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScoreLineage_verificationResultId_key"
  ON "ScoreLineage"("verificationResultId");
CREATE INDEX "ScoreLineage_expiresAt_idx"
  ON "ScoreLineage"("expiresAt");
CREATE INDEX "ScoreLineage_applicantId_computedAt_idx"
  ON "ScoreLineage"("applicantId", "computedAt");

ALTER TABLE "ScoreLineage"
  ADD CONSTRAINT "ScoreLineage_verificationResultId_fkey"
  FOREIGN KEY ("verificationResultId") REFERENCES "VerificationResult"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScoreLineage"
  ADD CONSTRAINT "ScoreLineage_applicantId_fkey"
  FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
