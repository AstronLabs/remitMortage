-- Issue #619: webhook delivery latency SLA monitoring.
-- Each attempt records when its dispatch started, when the attempt finished,
-- and whether it succeeded, will be retried, or was moved to the DLQ.

ALTER TABLE "WebhookDelivery" ADD COLUMN "dispatchedAt" TIMESTAMP(3);
ALTER TABLE "WebhookDelivery" ADD COLUMN "completedAt" TIMESTAMP(3);
ALTER TABLE "WebhookDelivery" ADD COLUMN "outcome" TEXT;

CREATE INDEX "WebhookDelivery_completedAt_idx" ON "WebhookDelivery"("completedAt");
