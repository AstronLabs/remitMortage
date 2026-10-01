-- Issue #749: hardship late-fee waiver request workflow.
-- Borrowers file structured hardship requests; admins record approve/deny/
-- partial decisions with amount + reason + approver for audit.

CREATE TYPE "FeeWaiverStatus" AS ENUM ('PENDING', 'APPROVED', 'PARTIAL', 'DENIED');
CREATE TYPE "HardshipReason" AS ENUM ('JOB_LOSS', 'MEDICAL_EMERGENCY', 'NATURAL_DISASTER', 'REDUCED_INCOME', 'BEREAVEMENT', 'OTHER');

CREATE TABLE "LateFeeWaiverRequest" (
  "id" TEXT NOT NULL,
  "loanApplicationId" TEXT NOT NULL,
  "borrowerAddress" TEXT NOT NULL,
  "hardshipReason" "HardshipReason" NOT NULL,
  "context" TEXT NOT NULL,
  "requestedAmount" DOUBLE PRECISION NOT NULL,
  "waivedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "status" "FeeWaiverStatus" NOT NULL DEFAULT 'PENDING',
  "decidedBy" TEXT,
  "decisionReason" TEXT,
  "policyVersion" TEXT NOT NULL DEFAULT 'waiver-policy-v1',
  "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LateFeeWaiverRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LateFeeWaiverRequest_loanApplicationId_status_idx"
  ON "LateFeeWaiverRequest"("loanApplicationId", "status");
CREATE INDEX "LateFeeWaiverRequest_status_createdAt_idx"
  ON "LateFeeWaiverRequest"("status", "createdAt");
CREATE INDEX "LateFeeWaiverRequest_borrowerAddress_idx"
  ON "LateFeeWaiverRequest"("borrowerAddress");
