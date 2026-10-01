-- Issue #802: automated employment/income verification via a third-party
-- payroll provider, falling back to manual document review. Only the
-- verification result and the confirmed income figure are stored.

CREATE TABLE "EmploymentVerification" (
  "id" TEXT NOT NULL,
  "applicantId" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "employerName" TEXT,
  "verifiedMonthlyIncome" TEXT,
  "providerReference" TEXT,
  "providerName" TEXT,
  "failureReason" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmploymentVerification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmploymentVerification_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "EmploymentVerification_applicantId_createdAt_idx" ON "EmploymentVerification"("applicantId", "createdAt");
