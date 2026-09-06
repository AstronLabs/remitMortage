CREATE TABLE "ReferralCode" (
  "id" TEXT NOT NULL,
  "ownerAddress" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReferralAttribution" (
  "id" TEXT NOT NULL,
  "referralCodeId" TEXT NOT NULL,
  "referredAddress" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ReferralAttribution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReferralCode_ownerAddress_key" ON "ReferralCode"("ownerAddress");
CREATE UNIQUE INDEX "ReferralCode_code_key" ON "ReferralCode"("code");
CREATE INDEX "ReferralCode_code_idx" ON "ReferralCode"("code");

CREATE UNIQUE INDEX "ReferralAttribution_referredAddress_key" ON "ReferralAttribution"("referredAddress");
CREATE INDEX "ReferralAttribution_referralCodeId_idx" ON "ReferralAttribution"("referralCodeId");
CREATE INDEX "ReferralAttribution_createdAt_idx" ON "ReferralAttribution"("createdAt");

ALTER TABLE "ReferralAttribution"
  ADD CONSTRAINT "ReferralAttribution_referralCodeId_fkey"
  FOREIGN KEY ("referralCodeId") REFERENCES "ReferralCode"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
