CREATE TYPE "CommunicationChannel" AS ENUM ('EMAIL', 'SMS', 'PUSH');

CREATE TYPE "CommunicationCategory" AS ENUM ('DEPOSITS', 'MILESTONES', 'GOVERNANCE', 'SECURITY');

CREATE TABLE "CommunicationPreference" (
  "id"               TEXT NOT NULL,
  "applicantId"      TEXT NOT NULL,
  "category"         "CommunicationCategory" NOT NULL,
  "channel"          "CommunicationChannel" NOT NULL,
  "enabled"          BOOLEAN NOT NULL DEFAULT false,
  "consentTimestamp" TIMESTAMP(3),
  "consentSource"    TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CommunicationPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommunicationPreference_applicantId_category_channel_key"
  ON "CommunicationPreference"("applicantId", "category", "channel");

CREATE INDEX "CommunicationPreference_applicantId_idx" ON "CommunicationPreference"("applicantId");

ALTER TABLE "CommunicationPreference"
  ADD CONSTRAINT "CommunicationPreference_applicantId_fkey"
  FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
