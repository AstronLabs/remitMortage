-- Issue #799: investor watchlist for upcoming (Pending) loan offerings.
-- notifiedAt marks that the watcher was told the offering opened, so the
-- notification is sent at most once per watch.

CREATE TABLE "OfferingWatch" (
  "id" TEXT NOT NULL,
  "investorAddress" TEXT NOT NULL,
  "loanApplicationId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notifiedAt" TIMESTAMP(3),
  CONSTRAINT "OfferingWatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OfferingWatch_loanApplicationId_fkey" FOREIGN KEY ("loanApplicationId") REFERENCES "LoanApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "OfferingWatch_investorAddress_loanApplicationId_key" ON "OfferingWatch"("investorAddress", "loanApplicationId");
CREATE INDEX "OfferingWatch_loanApplicationId_notifiedAt_idx" ON "OfferingWatch"("loanApplicationId", "notifiedAt");
CREATE INDEX "OfferingWatch_investorAddress_idx" ON "OfferingWatch"("investorAddress");
