-- AlterTable
ALTER TABLE "WebhookSubscription" ADD COLUMN "consecutiveFailedDispatches" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WebhookSubscription" ADD COLUMN "failingSinceAt" TIMESTAMP(3);
ALTER TABLE "WebhookSubscription" ADD COLUMN "lastFailureAt" TIMESTAMP(3);
ALTER TABLE "WebhookSubscription" ADD COLUMN "lastSuccessAt" TIMESTAMP(3);
ALTER TABLE "WebhookSubscription" ADD COLUMN "autoDisabledAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "WebhookSubscription_status_consecutiveFailedDispatches_idx" ON "WebhookSubscription"("status", "consecutiveFailedDispatches");
