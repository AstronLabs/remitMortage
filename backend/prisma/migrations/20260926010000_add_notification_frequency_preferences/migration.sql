CREATE TYPE "NotificationFrequency" AS ENUM ('IMMEDIATE', 'DAILY_DIGEST', 'WEEKLY_DIGEST');

ALTER TABLE "NotificationPreference"
  ADD COLUMN "governanceAlerts" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "depositsFrequency" "NotificationFrequency" NOT NULL DEFAULT 'IMMEDIATE',
  ADD COLUMN "milestonesFrequency" "NotificationFrequency" NOT NULL DEFAULT 'IMMEDIATE',
  ADD COLUMN "governanceFrequency" "NotificationFrequency" NOT NULL DEFAULT 'IMMEDIATE';
