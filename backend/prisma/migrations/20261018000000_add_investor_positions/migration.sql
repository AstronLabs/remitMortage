CREATE TABLE "InvestorPosition" (
  "id" TEXT NOT NULL,
  "walletAddress" TEXT NOT NULL,
  "deposited" TEXT NOT NULL DEFAULT '0',
  "claimedYield" TEXT NOT NULL DEFAULT '0',
  "startLedger" INTEGER NOT NULL DEFAULT 0,
  "tranche" TEXT NOT NULL,
  "accruedYield" TEXT NOT NULL DEFAULT '0',
  "absorbedLoss" TEXT NOT NULL DEFAULT '0',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InvestorPosition_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InvestorPosition_walletAddress_key" ON "InvestorPosition"("walletAddress");
CREATE INDEX "InvestorPosition_tranche_idx" ON "InvestorPosition"("tranche");
