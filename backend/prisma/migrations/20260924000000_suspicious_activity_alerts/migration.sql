CREATE TYPE "SuspiciousActivityStatus" AS ENUM ('OPEN', 'CLEARED', 'CONFIRMED');

CREATE TABLE "SuspiciousActivityAlert" (
  "id" TEXT NOT NULL,
  "borrowerId" TEXT NOT NULL,
  "ruleCode" TEXT NOT NULL,
  "ruleName" TEXT NOT NULL,
  "status" "SuspiciousActivityStatus" NOT NULL DEFAULT 'OPEN',
  "windowStart" TIMESTAMP(3) NOT NULL,
  "windowEnd" TIMESTAMP(3) NOT NULL,
  "evidence" JSONB NOT NULL,
  "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "reviewedBy" TEXT,
  "reviewNotes" TEXT,
  CONSTRAINT "SuspiciousActivityAlert_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SuspiciousActivityAlert_borrowerId_ruleCode_windowStart_key"
  ON "SuspiciousActivityAlert"("borrowerId", "ruleCode", "windowStart");
CREATE INDEX "SuspiciousActivityAlert_status_detectedAt_idx"
  ON "SuspiciousActivityAlert"("status", "detectedAt");
CREATE INDEX "SuspiciousActivityAlert_borrowerId_detectedAt_idx"
  ON "SuspiciousActivityAlert"("borrowerId", "detectedAt");
ALTER TABLE "SuspiciousActivityAlert"
  ADD CONSTRAINT "SuspiciousActivityAlert_borrowerId_fkey"
  FOREIGN KEY ("borrowerId") REFERENCES "Borrower"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
