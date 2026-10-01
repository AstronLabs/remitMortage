# Unused Index Review & Removal Process

> Issue #758. The unused-index audit is a **report-only pipeline**: it never
> drops an index automatically. Every removal below is a human decision with a
> migration, a rollback plan, and a second pair of eyes.

## What the scheduled job does

- **Cadence:** weekly, Monday 10:00 UTC (`UNUSED_INDEX_AUDIT_CRON_SCHEDULE`,
  default `0 10 * * 1`), wired in `backend/src/jobs/scheduler.ts`.
- **Signal:** `pg_stat_user_indexes.idx_scan` joined with `pg_index` /
  `pg_constraint` (constraint detection) and `pg_relation_size` (reclaimable
  size). Implementation: `backend/src/jobs/unusedIndexAudit.ts`, pure rules in
  `backend/src/services/unusedIndexAudit.ts`.
- **"Sustained" definition:** an index is a candidate only after
  `UNUSED_INDEX_MIN_OBSERVATION_DAYS` (default 14) days under observation
  **and** near-zero scans (`UNUSED_INDEX_MAX_SCANS`, default 0) across **two
  consecutive scheduled runs**. Consecutive-run totals persist in
  `storage/unused-index-snapshot.json` (`UNUSED_INDEX_SNAPSHOT_PATH`
  override). A `pg_stat` reset is treated as a fresh observation, never as
  evidence of use.
- **Never flagged:** primary-key and unique-constraint backing indexes are
  excluded from candidates regardless of scan activity, and are listed
  separately in the report under "excluded".
- **Delivery:** email to `UNUSED_INDEX_DIGEST_RECIPIENTS` (fallback: compliance
  alert email) plus an `UNUSED_INDEX_AUDIT_REPORT` audit-log row. Manual
  trigger: `GET /api/admin/db/unused-indexes` (admin-gated).

## Human review process (required before any DROP)

1. **Triage the report.** For each candidate, confirm table, columns, size,
   and idle-observation count. Open the index definition
   (`pg_get_indexdef`) from the report.
2. **Check for a superseding index.** If a later composite index covers the
   same leading column(s) (e.g. `(applicantId, status)` supersedes
   `(applicantId)` for the app's query patterns), the older index is usually
   safe to remove — note the superseding index name in the removal PR.
3. **Check non-query uses.** Confirm the index does not back a constraint
   (the report already excludes these, but re-verify in the migration), is
   not referenced by `ORDER BY` / foreign-key fast-path plans, and is not
   required by an upcoming feature branch.
4. **Stage the removal as a migration.** Author a Prisma migration with
   `DROP INDEX CONCURRENTLY <name>` (concurrently — never block writes),
   generated during a low-traffic window. Include in the PR:
   - the report excerpt (index, table, size, idle observations),
   - the superseding index or removed-feature reference,
   - a rollback migration (`CREATE INDEX CONCURRENTLY` with the original
     definition from the report).
5. **Two-person rule.** A DBA or backend owner must approve. Merge only after
   CI (including the query-plan regression check) passes.
6. **Watch one release.** After deploy, monitor slow-query digest and error
   rates for the affected tables for at least one weekly cycle before
   closing the follow-up issue.

## What this pipeline will never do

- Automatically `DROP` an index.
- Flag `PRIMARY KEY` / `UNIQUE` constraint indexes as removal candidates.
- Treat a single idle observation (or a stats reset) as "sustained" evidence.
