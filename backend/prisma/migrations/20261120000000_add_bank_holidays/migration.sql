-- Per-country bank holidays for payment cutoffs (issue #980).
--
-- Weekends are always non-business days; each row adds one holiday for one
-- country. `date` holds the holiday at UTC midnight. Admins edit the table
-- through /api/admin/calendar/holidays, so no deploy is needed.

CREATE TABLE "BankHoliday" (
  "id" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "name" TEXT,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BankHoliday_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BankHoliday_country_date_key" ON "BankHoliday"("country", "date");
