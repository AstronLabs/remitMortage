# Prisma migration rollback verification

Every Prisma migration must declare how it can be undone, and CI verifies that
the declared rollback actually restores the pre-migration schema. Discovering
that a migration is irreversible during a live incident is exactly what this
gate prevents.

## For migration authors

### Reversible migrations — add `down.sql`

Put a `down.sql` next to your `migration.sql` that reverses it:

```
backend/prisma/migrations/
  20260901000000_add_widget/
    migration.sql   # up
    down.sql        # rollback
```

Write it defensively (`DROP ... IF EXISTS`, `ADD COLUMN IF NOT EXISTS`) so it is
idempotent, because the verifier applies it more than once.

The verifier loads the committed production schema snapshot, applies your
`down.sql` to reach the pre-migration state, applies your `migration.sql` then
`down.sql` again, and diffs the schema before/after. Any difference fails the
check. See `backend/prisma/migrations/20260829160000_add_referral_attribution`
for a worked example.

### Irreversible migrations — add a reviewed runbook

If a migration genuinely cannot be reversed automatically (for example it adds a
`LoanStatus` enum value, which PostgreSQL cannot remove, or it rewrites table
storage), list it in `backend/prisma/rollback-manifest.json` and commit a
runbook:

```json
{
  "irreversible": [
    {
      "migration": "20260901000000_add_widget",
      "runbook": "rollback-runbooks/20260901000000_add_widget.md",
      "reason": "why an automated rollback is unsafe"
    }
  ]
}
```

The runbook (in `backend/prisma/rollback-runbooks/`) must describe the manual
rollback steps and how to verify them. The manifest is reviewed as part of the
PR, so an irreversible migration can only merge with sign-off.

A migration must have exactly one of the two: a `down.sql`, or a manifest entry
with an existing runbook. Having both, having neither, or pointing at a missing
runbook all fail the check.

## Unsafe-operation lint

Separately from rollback coverage, `backend/scripts/migration-safety-gate.ts`
lints migration SQL for operations that can fail or stall production: a
`NOT NULL` column added with no default, `SET NOT NULL`, `ALTER COLUMN ... TYPE`,
a foreign key or check constraint added without `NOT VALID`, a `UNIQUE`
constraint, a non-`CONCURRENTLY` index build, and `DROP COLUMN` / `DROP TABLE` /
`RENAME`. Print the full list with:

```bash
cd backend
npx tsx scripts/migration-safety-gate.ts --list-patterns
```

A migration that genuinely needs one of these operations declares a reviewed
waiver with a reason, on the statement it covers or the line above:

```sql
-- migration-ok: the table is empty at deploy time, so NOT NULL is instant
ALTER TABLE "Loan" ADD COLUMN "flag" TEXT NOT NULL;
```

A bare `-- migration-ok:` with no reason is not honoured. Migrations that
predate the lint are grandfathered in; only migrations added afterwards are
checked. Run it over history with `--all`, or pin a cut-off with
`--since <stamp>`.

## Running the check locally

Coverage only (no database needed):

```bash
cd backend
npx tsx scripts/check-migration-rollbacks.ts
```

Full schema comparison against a throwaway database:

```bash
cd backend
# point at a scratch database; the public schema is dropped and recreated
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rollback_check \
  bash scripts/verify-migration-rollback.sh
```

`SKIP_DB=1` runs the coverage check only. `ROLLBACK_BASELINE_SQL` overrides the
schema seed (defaults to `backend/prisma/__snapshots__/production-schema.sql`).

## In CI

`.github/workflows/migration-rollback.yml` runs both steps on a `postgres:16`
service whenever migrations, the manifest, the runbooks, or the verifier change.
A pull request that adds a migration without a rollback path, or with a
`down.sql` that leaves schema residue, fails the job.
