# Rollback runbook — 20260828000000_add_draft_stale_cleanup_fields

**Type:** irreversible (enum mutation) · **Reviewed:** required before merge

## What the migration does

Adds the `'Draft'` value to the `LoanStatus` enum, adds the
`LoanApplication.lastActivityAt` / `draftStaleNotifiedAt` columns, and indexes
`(status, lastActivityAt)`.

## Why it is not automatically reversible

PostgreSQL cannot remove a value from an enum type. Reverting means rebuilding
the `LoanStatus` type and rewriting every column that uses it. The column and
index additions are trivially reversible; the enum change is not.

## Rollback procedure

1. Take a backup.
2. Remove the dependent objects first:
   ```sql
   DROP INDEX IF EXISTS "LoanApplication_status_lastActivityAt_idx";
   ALTER TABLE "LoanApplication" DROP COLUMN IF EXISTS "draftStaleNotifiedAt";
   ALTER TABLE "LoanApplication" DROP COLUMN IF EXISTS "lastActivityAt";
   ```
3. Rebuild the enum without `'Draft'` (requires a maintenance window):
   ```sql
   ALTER TYPE "LoanStatus" RENAME TO "LoanStatus_old";
   CREATE TYPE "LoanStatus" AS ENUM
     ('Pending','Approved','Rejected','Disbursing','Repaying','Completed');
   ALTER TABLE "LoanApplication"
     ALTER COLUMN "status" TYPE "LoanStatus"
     USING ("status"::text::"LoanStatus");
   DROP TYPE "LoanStatus_old";
   ```
4. Confirm no rows still reference `'Draft'` before step 3 (they would fail the
   cast): `SELECT count(*) FROM "LoanApplication" WHERE "status" = 'Draft';`

## Verification

- `SELECT enum_range(NULL::"LoanStatus");` no longer contains `Draft`.
- The two columns and index are gone.
