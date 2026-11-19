Loaded Prisma config from prisma.config.ts.

-- CreateEnum
CREATE TYPE "GuarantorStatus" AS ENUM ('Accepted', 'Rejected');

-- CreateEnum
CREATE TYPE "ServicingTransferStatus" AS ENUM ('SCHEDULED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "AutoRejectionRuleType" AS ENUM ('MIN_CREDIT_SCORE', 'MAX_DEBT_TO_INCOME', 'REQUIRES_VERIFICATION');

-- CreateEnum
CREATE TYPE "SuspiciousActivityStatus" AS ENUM ('OPEN', 'CLEARED', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "ReviewerStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ON_LEAVE');

-- CreateEnum
CREATE TYPE "EmailSuppressionReason" AS ENUM ('HARD_BOUNCE', 'SOFT_BOUNCE', 'SPAM_COMPLAINT');

-- CreateEnum
CREATE TYPE "FeeWaiverStatus" AS ENUM ('PENDING', 'APPROVED', 'PARTIAL', 'DENIED');

-- CreateEnum
CREATE TYPE "HardshipReason" AS ENUM ('JOB_LOSS', 'MEDICAL_EMERGENCY', 'NATURAL_DISASTER', 'REDUCED_INCOME', 'BEREAVEMENT', 'OTHER');

-- AlterEnum
ALTER TYPE "LoanStatus" ADD VALUE 'Draft';

-- AlterTable
ALTER TABLE "Applicant" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "taxIdHash" TEXT;

-- AlterTable
ALTER TABLE "LoanApplication" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "assigned_reviewer_id" TEXT,
ADD COLUMN     "autoRejectedAt" TIMESTAMP(3),
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "draftStaleNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "manualReviewReason" TEXT,
ADD COLUMN     "reason" TEXT,
ADD COLUMN     "servicer" TEXT,
ADD COLUMN     "servicerContact" TEXT;

-- AlterTable
ALTER TABLE "Borrower" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "WebhookSubscription" ADD COLUMN     "deprecationNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "webhookSchemaVersion" INTEGER NOT NULL DEFAULT 2;

-- AlterTable
ALTER TABLE "WebhookDelivery" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "dispatchedAt" TIMESTAMP(3),
ADD COLUMN     "outcome" TEXT;

-- DropTable
DROP TABLE "BashDriftProbe";

-- CreateTable
CREATE TABLE "LinkedBankAccount" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "accountHash" TEXT NOT NULL,
    "accountLast4" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkedBankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KycOcrResult" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "applicantAddress" TEXT NOT NULL,
    "extractedName" TEXT,
    "nameConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "extractedIdNumber" TEXT,
    "idNumberConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "extractedAddress" TEXT,
    "addressConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "ocrFailed" BOOLEAN NOT NULL DEFAULT false,
    "ocrError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KycOcrResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanServicingTransfer" (
    "id" TEXT NOT NULL,
    "loanApplicationId" TEXT NOT NULL,
    "fromServicer" TEXT,
    "fromServicerContact" TEXT,
    "toServicer" TEXT NOT NULL,
    "toServicerContact" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ServicingTransferStatus" NOT NULL DEFAULT 'SCHEDULED',
    "initiatedBy" TEXT NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanServicingTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanAutoRejectionRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ruleType" "AutoRejectionRuleType" NOT NULL,
    "config" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoanAutoRejectionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanAutoRejectionLog" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanAutoRejectionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanComment" (
    "id" TEXT NOT NULL,
    "loanApplicationId" TEXT NOT NULL,
    "authorAddress" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "parentId" TEXT,
    "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoanComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "InviteCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "email" TEXT,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "usedBy" TEXT,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "InviteCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaitlistEntry" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "walletAddress" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "inviteCode" TEXT,
    "position" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reviewer" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "status" "ReviewerStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastAssignedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reviewer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlowQueryLog" (
    "id" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "model" TEXT,
    "operation" TEXT,
    "durationMs" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlowQueryLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSuppression" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" "EmailSuppressionReason" NOT NULL,
    "permanent" BOOLEAN NOT NULL DEFAULT false,
    "suppressedUntil" TIMESTAMP(3),
    "softBounceCount" INTEGER NOT NULL DEFAULT 0,
    "flaggedForReview" BOOLEAN NOT NULL DEFAULT false,
    "lastDetail" TEXT,
    "lastEventAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LateFeeWaiverRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LinkedBankAccount_accountHash_idx" ON "LinkedBankAccount"("accountHash");

-- CreateIndex
CREATE UNIQUE INDEX "LinkedBankAccount_applicantId_accountHash_key" ON "LinkedBankAccount"("applicantId", "accountHash");

-- CreateIndex
CREATE UNIQUE INDEX "KycOcrResult_documentId_key" ON "KycOcrResult"("documentId");

-- CreateIndex
CREATE INDEX "KycOcrResult_applicantAddress_idx" ON "KycOcrResult"("applicantAddress");

-- CreateIndex
CREATE INDEX "LoanServicingTransfer_loanApplicationId_createdAt_idx" ON "LoanServicingTransfer"("loanApplicationId", "createdAt");

-- CreateIndex
CREATE INDEX "LoanServicingTransfer_status_effectiveDate_idx" ON "LoanServicingTransfer"("status", "effectiveDate");

-- CreateIndex
CREATE INDEX "LoanAutoRejectionRule_active_priority_idx" ON "LoanAutoRejectionRule"("active", "priority");

-- CreateIndex
CREATE INDEX "LoanAutoRejectionLog_applicationId_idx" ON "LoanAutoRejectionLog"("applicationId");

-- CreateIndex
CREATE INDEX "LoanAutoRejectionLog_ruleId_idx" ON "LoanAutoRejectionLog"("ruleId");

-- CreateIndex
CREATE INDEX "LoanAutoRejectionLog_createdAt_idx" ON "LoanAutoRejectionLog"("createdAt");

-- CreateIndex
CREATE INDEX "LoanComment_loanApplicationId_createdAt_idx" ON "LoanComment"("loanApplicationId", "createdAt");

-- CreateIndex
CREATE INDEX "LoanComment_parentId_idx" ON "LoanComment"("parentId");

-- CreateIndex
CREATE INDEX "LoanComment_authorAddress_idx" ON "LoanComment"("authorAddress");

-- CreateIndex
CREATE INDEX "SuspiciousActivityAlert_status_detectedAt_idx" ON "SuspiciousActivityAlert"("status", "detectedAt");

-- CreateIndex
CREATE INDEX "SuspiciousActivityAlert_borrowerId_detectedAt_idx" ON "SuspiciousActivityAlert"("borrowerId", "detectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SuspiciousActivityAlert_borrowerId_ruleCode_windowStart_key" ON "SuspiciousActivityAlert"("borrowerId", "ruleCode", "windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "InviteCode_code_key" ON "InviteCode"("code");

-- CreateIndex
CREATE INDEX "InviteCode_code_idx" ON "InviteCode"("code");

-- CreateIndex
CREATE INDEX "InviteCode_used_idx" ON "InviteCode"("used");

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistEntry_email_key" ON "WaitlistEntry"("email");

-- CreateIndex
CREATE INDEX "WaitlistEntry_email_idx" ON "WaitlistEntry"("email");

-- CreateIndex
CREATE INDEX "WaitlistEntry_status_idx" ON "WaitlistEntry"("status");

-- CreateIndex
CREATE INDEX "WaitlistEntry_createdAt_idx" ON "WaitlistEntry"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Reviewer_email_key" ON "Reviewer"("email");

-- CreateIndex
CREATE INDEX "Reviewer_status_lastAssignedAt_idx" ON "Reviewer"("status", "lastAssignedAt");

-- CreateIndex
CREATE INDEX "SlowQueryLog_occurredAt_idx" ON "SlowQueryLog"("occurredAt");

-- CreateIndex
CREATE INDEX "SlowQueryLog_fingerprint_idx" ON "SlowQueryLog"("fingerprint");

-- CreateIndex
CREATE INDEX "SlowQueryLog_fingerprint_occurredAt_idx" ON "SlowQueryLog"("fingerprint", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_email_key" ON "EmailSuppression"("email");

-- CreateIndex
CREATE INDEX "EmailSuppression_permanent_idx" ON "EmailSuppression"("permanent");

-- CreateIndex
CREATE INDEX "LateFeeWaiverRequest_loanApplicationId_status_idx" ON "LateFeeWaiverRequest"("loanApplicationId", "status");

-- CreateIndex
CREATE INDEX "LateFeeWaiverRequest_status_createdAt_idx" ON "LateFeeWaiverRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "LateFeeWaiverRequest_borrowerAddress_idx" ON "LateFeeWaiverRequest"("borrowerAddress");

-- CreateIndex
CREATE INDEX "Applicant_deletedAt_idx" ON "Applicant"("deletedAt");

-- CreateIndex
CREATE INDEX "Applicant_taxIdHash_idx" ON "Applicant"("taxIdHash");

-- CreateIndex
CREATE INDEX "LoanApplication_deletedAt_idx" ON "LoanApplication"("deletedAt");

-- CreateIndex
CREATE INDEX "LoanApplication_status_lastActivityAt_idx" ON "LoanApplication"("status", "lastActivityAt");

-- CreateIndex
CREATE INDEX "LoanApplication_assigned_reviewer_id_idx" ON "LoanApplication"("assigned_reviewer_id");

-- CreateIndex
CREATE INDEX "Borrower_deletedAt_idx" ON "Borrower"("deletedAt");

-- CreateIndex
CREATE INDEX "WebhookSubscription_webhookSchemaVersion_idx" ON "WebhookSubscription"("webhookSchemaVersion");

-- CreateIndex
CREATE INDEX "WebhookDelivery_completedAt_idx" ON "WebhookDelivery"("completedAt");

-- AddForeignKey
ALTER TABLE "LinkedBankAccount" ADD CONSTRAINT "LinkedBankAccount_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_assigned_reviewer_id_fkey" FOREIGN KEY ("assigned_reviewer_id") REFERENCES "Reviewer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanServicingTransfer" ADD CONSTRAINT "LoanServicingTransfer_loanApplicationId_fkey" FOREIGN KEY ("loanApplicationId") REFERENCES "LoanApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanAutoRejectionLog" ADD CONSTRAINT "LoanAutoRejectionLog_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "LoanApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanAutoRejectionLog" ADD CONSTRAINT "LoanAutoRejectionLog_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "LoanAutoRejectionRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanComment" ADD CONSTRAINT "LoanComment_loanApplicationId_fkey" FOREIGN KEY ("loanApplicationId") REFERENCES "LoanApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanComment" ADD CONSTRAINT "LoanComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "LoanComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuspiciousActivityAlert" ADD CONSTRAINT "SuspiciousActivityAlert_borrowerId_fkey" FOREIGN KEY ("borrowerId") REFERENCES "Borrower"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
