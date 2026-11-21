-- AlterEnum
ALTER TYPE "LoanStatus" ADD VALUE 'Withdrawn';

-- AlterTable
ALTER TABLE "LoanApplication" ADD COLUMN "withdrawnAt" TIMESTAMP(3);
ALTER TABLE "LoanApplication" ADD COLUMN "withdrawalReason" TEXT;

-- CreateTable
CREATE TABLE "ApplicationProgress" (
    "id" TEXT NOT NULL,
    "stellarAddress" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "totalSteps" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationProgress_stellarAddress_key" ON "ApplicationProgress"("stellarAddress");
