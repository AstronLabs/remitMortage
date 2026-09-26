-- Issue #694: email bounce handling and suppression list.
-- Populated by the email provider's bounce/complaint webhook and checked
-- before every outbound send.

CREATE TYPE "EmailSuppressionReason" AS ENUM ('HARD_BOUNCE', 'SOFT_BOUNCE', 'SPAM_COMPLAINT');

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

CREATE UNIQUE INDEX "EmailSuppression_email_key" ON "EmailSuppression"("email");
CREATE INDEX "EmailSuppression_permanent_idx" ON "EmailSuppression"("permanent");
