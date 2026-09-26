-- Rollback for 20260827_add_loan_check_constraints.
-- Drops the CHECK constraints and the interestRateBps column the migration added.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'LoanApplication_interestRateBps_check'
      AND conrelid = '"LoanApplication"'::regclass
  ) THEN
    ALTER TABLE "LoanApplication" DROP CONSTRAINT "LoanApplication_interestRateBps_check";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'LoanApplication_principal_check'
      AND conrelid = '"LoanApplication"'::regclass
  ) THEN
    ALTER TABLE "LoanApplication" DROP CONSTRAINT "LoanApplication_principal_check";
  END IF;
END $$;

ALTER TABLE "LoanApplication" DROP COLUMN IF EXISTS "interestRateBps";
