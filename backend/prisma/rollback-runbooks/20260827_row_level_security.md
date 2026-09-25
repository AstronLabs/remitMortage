# Rollback runbook — 20260827_row_level_security

**Type:** irreversible (security posture) · **Reviewed:** required before merge

## What the migration does

Creates the tenant-context helper functions (`set_current_tenant`,
`get_current_tenant`, `set_tenant_bypass`), enables row-level security on
`Applicant`, `LoanApplication`, `Borrower`, `VerificationResult`,
`BorrowerCredential`, `KycDocument` and `NotificationPreference`, and installs
tenant-isolation policies on them.

## Why it is not automatically reversible

Disabling row-level security and dropping the tenant policies removes a data
isolation guarantee. That must happen only with an explicit, reviewed operator
decision — never silently as part of an automated rollback.

## Rollback procedure

1. Confirm the operator has approved removing tenant isolation.
2. Discover the installed policies (do not hardcode — enumerate):
   ```sql
   SELECT schemaname, tablename, policyname FROM pg_policies
   ORDER BY tablename, policyname;
   ```
3. For every table listed by:
   ```sql
   SELECT tablename FROM pg_tables t
   WHERE EXISTS (SELECT 1 FROM pg_policies p
                 WHERE p.schemaname = t.schemaname AND p.tablename = t.tablename);
   ```
   run `ALTER TABLE "<table>" DISABLE ROW LEVEL SECURITY;`
4. `DROP POLICY IF EXISTS tenant_isolation_<table> ON "<table>";` for each policy
   from step 2.
5. `DROP FUNCTION IF EXISTS set_current_tenant(TEXT);`
   `DROP FUNCTION IF EXISTS get_current_tenant();`
   `DROP FUNCTION IF EXISTS set_tenant_bypass(BOOLEAN);`
6. Re-run the data-access tests and confirm the expected access level.

## Verification

- `SELECT count(*) FROM pg_policies;` returns zero for the affected tables.
- No table has `relrowsecurity = true` for the affected set.
