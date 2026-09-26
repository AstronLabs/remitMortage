-- Rollback for 20260825_add_loan_application_composite_indexes.
DROP INDEX IF EXISTS "LoanApplication_applicantId_status_idx";
DROP INDEX IF EXISTS "LoanApplication_status_createdAt_idx";
