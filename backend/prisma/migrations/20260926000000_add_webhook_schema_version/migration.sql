ALTER TABLE "WebhookSubscription"
  ADD COLUMN "webhookSchemaVersion" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "deprecationNotifiedAt" TIMESTAMP(3);

CREATE INDEX "WebhookSubscription_webhookSchemaVersion_idx"
  ON "WebhookSubscription"("webhookSchemaVersion");
