# Rollback runbook — 20260825_partition_auditlog

**Type:** irreversible (data-rewriting) · **Reviewed:** required before merge

## What the migration does

Renames `AuditLog` to `AuditLog_old`, creates a new partitioned `AuditLog`
(monthly range partitions plus a default partition), copies every row across,
then drops `AuditLog_old`.

## Why it is not automatically reversible

Reversing it means rebuilding an unpartitioned table and copying the rows back.
That is a data movement operation that must be run deliberately with a
maintenance window, a row-count check, and a backup — not from CI.

## Rollback procedure

1. Take a verified backup of `AuditLog` (`pg_dump -t '"AuditLog"'`).
2. Verify the source partition tables: `SELECT relname FROM pg_class WHERE
   relname LIKE 'AuditLog_%' ORDER BY relname;`
3. Record counts: `SELECT count(*) FROM "AuditLog";`
4. In a maintenance window, stop writes to `AuditLog` (pause audit consumers).
5. Create `AuditLog_restore` with the pre-partitioning column definition
   (see `production-schema.sql` snapshot), then
   `INSERT INTO "AuditLog_restore" SELECT ... FROM "AuditLog";`
6. Confirm the copied count matches step 3.
7. `DROP TABLE "AuditLog";` then `ALTER TABLE "AuditLog_restore" RENAME TO "AuditLog";`
8. Recreate the pre-migration indexes
   (`AuditLog_action_idx`, `AuditLog_actorAddress_idx`, `AuditLog_createdAt_idx`,
   `AuditLog_action_createdAt_idx`).
9. Re-run the audit-log read tests and confirm the API returns the expected rows.

## Verification

- Row count after restore equals the count before rollback.
- The four indexes above exist.
- `make test` / the `prisma-drift` check pass against the restored schema.
