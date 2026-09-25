-- Issue #693: loan servicing transfer between originators.
-- LoanApplication carries the current servicer of record; every transfer is
-- appended to LoanServicingTransfer so prior servicers stay queryable.

ALTER TABLE "LoanApplication" ADD COLUMN "servicer" TEXT;
ALTER TABLE "LoanApplication" ADD COLUMN "servicerContact" TEXT;

CREATE TYPE "ServicingTransferStatus" AS ENUM ('SCHEDULED', 'COMPLETED');

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

CREATE INDEX "LoanServicingTransfer_loanApplicationId_createdAt_idx"
  ON "LoanServicingTransfer"("loanApplicationId", "createdAt");
CREATE INDEX "LoanServicingTransfer_status_effectiveDate_idx"
  ON "LoanServicingTransfer"("status", "effectiveDate");

ALTER TABLE "LoanServicingTransfer"
  ADD CONSTRAINT "LoanServicingTransfer_loanApplicationId_fkey"
  FOREIGN KEY ("loanApplicationId") REFERENCES "LoanApplication"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
