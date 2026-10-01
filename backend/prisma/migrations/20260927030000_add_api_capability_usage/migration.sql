-- Issue #772: least-privilege scope audit for outbound third-party credentials.
-- Tracks, per (integration, capability), whether our code has ever actually
-- exercised it — compared at audit time against each credential's granted
-- provider scope to flag scopes that were granted but never used.

CREATE TABLE "ApiCapabilityUsage" (
  "id" TEXT NOT NULL,
  "integration" TEXT NOT NULL,
  "capability" TEXT NOT NULL,
  "callCount" INTEGER NOT NULL DEFAULT 0,
  "lastUsedAt" TIMESTAMP(3),
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApiCapabilityUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiCapabilityUsage_integration_capability_key" ON "ApiCapabilityUsage"("integration", "capability");
CREATE INDEX "ApiCapabilityUsage_integration_idx" ON "ApiCapabilityUsage"("integration");
