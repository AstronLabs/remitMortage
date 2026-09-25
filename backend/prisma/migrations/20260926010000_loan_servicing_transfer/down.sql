DROP TABLE IF EXISTS "LoanServicingTransfer";
DROP TYPE IF EXISTS "ServicingTransferStatus";

ALTER TABLE "LoanApplication" DROP COLUMN IF EXISTS "servicerContact";
ALTER TABLE "LoanApplication" DROP COLUMN IF EXISTS "servicer";
