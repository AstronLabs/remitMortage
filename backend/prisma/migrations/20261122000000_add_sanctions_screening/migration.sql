-- Issue #922: sanctions screening at onboarding and on a schedule.
CREATE TABLE "SanctionsScreening" (
  "id" TEXT NOT NULL,
  "partyType" TEXT NOT NULL,
  "partyAddress" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "matchLevel" TEXT,
  "matchFingerprint" TEXT,
  "reviewedFingerprint" TEXT,
  "subjectNameEnc" TEXT,
  "subjectCountry" TEXT,
  "listVersion" TEXT,
  "providerName" TEXT,
  "providerReference" TEXT,
  "lastScreenedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SanctionsScreening_pkey" PRIMARY KEY ("id")
);

-- migration-ok: the table is created empty in this same migration, so there is nothing to lock
CREATE UNIQUE INDEX "SanctionsScreening_partyType_partyAddress_key"
  ON "SanctionsScreening"("partyType", "partyAddress");
-- migration-ok: the table is created empty in this same migration, so there is nothing to lock
CREATE INDEX "SanctionsScreening_status_idx" ON "SanctionsScreening"("status");
-- migration-ok: the table is created empty in this same migration, so there is nothing to lock
CREATE INDEX "SanctionsScreening_lastScreenedAt_idx" ON "SanctionsScreening"("lastScreenedAt");

CREATE TABLE "SanctionsScreeningEvent" (
  "id" TEXT NOT NULL,
  "screeningId" TEXT NOT NULL,
  "partyType" TEXT NOT NULL,
  "partyAddress" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "outcome" TEXT,
  "status" TEXT NOT NULL,
  "listVersion" TEXT,
  "actor" TEXT,
  "note" TEXT,
  "detail" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SanctionsScreeningEvent_pkey" PRIMARY KEY ("id")
);

-- migration-ok: the table is created empty in this same migration, so there is nothing to lock
CREATE INDEX "SanctionsScreeningEvent_screeningId_createdAt_idx"
  ON "SanctionsScreeningEvent"("screeningId", "createdAt");
-- migration-ok: the table is created empty in this same migration, so there is nothing to lock
CREATE INDEX "SanctionsScreeningEvent_partyType_partyAddress_idx"
  ON "SanctionsScreeningEvent"("partyType", "partyAddress");

-- migration-ok: the table is created empty in this same migration, so there is nothing to lock
ALTER TABLE "SanctionsScreeningEvent"
  ADD CONSTRAINT "SanctionsScreeningEvent_screeningId_fkey"
  FOREIGN KEY ("screeningId") REFERENCES "SanctionsScreening"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
