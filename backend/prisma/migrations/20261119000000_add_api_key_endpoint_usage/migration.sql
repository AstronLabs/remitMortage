-- Per-key, per-billing-period, per-endpoint request counter (issue #1053).
--
-- The drill-down behind ApiKeyUsage's per-period total. One row per
-- (apiKeyId, periodStart, endpoint), incremented alongside the total on every
-- metered request, so a key's endpoint breakdown sums back to the same period
-- total it is metered against.

CREATE TABLE "ApiKeyEndpointUsage" (
  "id" TEXT NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "endpoint" TEXT NOT NULL,
  "requestCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ApiKeyEndpointUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiKeyEndpointUsage_apiKeyId_periodStart_endpoint_key"
  ON "ApiKeyEndpointUsage"("apiKeyId", "periodStart", "endpoint");
CREATE INDEX "ApiKeyEndpointUsage_apiKeyId_periodStart_idx"
  ON "ApiKeyEndpointUsage"("apiKeyId", "periodStart");
ALTER TABLE "ApiKeyEndpointUsage"
  ADD CONSTRAINT "ApiKeyEndpointUsage_apiKeyId_fkey"
  FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
