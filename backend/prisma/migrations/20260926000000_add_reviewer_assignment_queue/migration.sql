-- Issue #621: configurable round-robin application assignment queue.
-- Adds review staff and links each loan application to the reviewer it was
-- assigned to on submission (or by a manual admin override).

-- CreateEnum
CREATE TYPE "ReviewerStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ON_LEAVE');

-- AlterTable
ALTER TABLE "LoanApplication" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "assigned_reviewer_id" TEXT;

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

-- CreateIndex
CREATE UNIQUE INDEX "Reviewer_email_key" ON "Reviewer"("email");

-- CreateIndex
CREATE INDEX "Reviewer_status_lastAssignedAt_idx" ON "Reviewer"("status", "lastAssignedAt");

-- CreateIndex
CREATE INDEX "LoanApplication_assigned_reviewer_id_idx" ON "LoanApplication"("assigned_reviewer_id");

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_assigned_reviewer_id_fkey" FOREIGN KEY ("assigned_reviewer_id") REFERENCES "Reviewer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
