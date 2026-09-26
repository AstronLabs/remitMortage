#!/usr/bin/env bash
#
# Prisma Migration Rollback Verifier
#
# Proves that every reversible migration can be rolled back cleanly, and that
# every irreducible migration has a reviewed runbook entry.
#
# For each migration with a `down.sql` this script:
#   1. loads the committed production schema snapshot into a scratch database,
#   2. applies the migration's own down.sql to reach the pre-migration state,
#   3. applies the migration up, then down again,
#   4. diffs the schema before step 3 against the schema after it.
# If the two dumps differ, the rollback leaves schema residue and the check
# fails. Migrations listed in prisma/rollback-manifest.json are skipped here
# (their runbook is the rollback procedure) but are still required to exist by
# the static coverage check.
#
# Usage:
#   DATABASE_URL=postgres://... ./backend/scripts/verify-migration-rollback.sh
#   SKIP_DB=1 ./backend/scripts/verify-migration-rollback.sh   # coverage only
#
# Environment:
#   DATABASE_URL            scratch database (throwaway)
#   ROLLBACK_DATABASE_URL   overrides DATABASE_URL
#   ROLLBACK_BASELINE_SQL   full-schema SQL seed (default: production snapshot)
#   SKIP_DB=1               run only the static coverage check

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$BACKEND_DIR/prisma/migrations"
MANIFEST="$BACKEND_DIR/prisma/rollback-manifest.json"
BASELINE_SQL="${ROLLBACK_BASELINE_SQL:-$BACKEND_DIR/prisma/__snapshots__/production-schema.sql}"
DATABASE_URL="${ROLLBACK_DATABASE_URL:-${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/rollback_check}}"

echo "== checking rollback coverage =="
(
  cd "$BACKEND_DIR"
  npx tsx scripts/check-migration-rollbacks.ts \
    --migrations-dir "$MIGRATIONS_DIR" \
    --manifest "$MANIFEST"
)

if [[ "${SKIP_DB:-0}" == "1" ]]; then
  echo "SKIP_DB=1 set — skipping the schema comparison step."
  exit 0
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required for the schema comparison step" >&2
  exit 1
fi
if [[ ! -f "$BASELINE_SQL" ]]; then
  echo "baseline schema SQL not found: $BASELINE_SQL" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

psql_run() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q "$@"; }

reset_database() {
  psql_run -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
  psql_run -f "$BASELINE_SQL"
}

dump_schema() {
  pg_dump "$DATABASE_URL" --schema-only --schema=public \
    --no-owner --no-privileges --no-comments \
    | grep -v -e '^--' -e '^SET ' -e '^SELECT pg_catalog.set_config' -e '^\\' -e '^$' \
    | sed -E 's/[[:space:]]+$//' > "$1"
}

verifiable=()
for dir in "$MIGRATIONS_DIR"/*/; do
  [[ -f "$dir/down.sql" ]] || continue
  verifiable+=("$(basename "$dir")")
done

if [[ ${#verifiable[@]} -eq 0 ]]; then
  echo "No migrations with down.sql found — nothing to verify."
  exit 0
fi

failed=0
for name in "${verifiable[@]}"; do
  dir="$MIGRATIONS_DIR/$name"
  echo "== verifying rollback of $name =="
  reset_database

  if ! psql_run -f "$dir/down.sql" >/dev/null 2>"$WORK/down-pre.err"; then
    echo "✗ down.sql failed to apply before the migration: $name"
    cat "$WORK/down-pre.err"
    failed=1
    continue
  fi
  dump_schema "$WORK/before.sql"

  if ! psql_run -f "$dir/migration.sql" >/dev/null 2>"$WORK/up.err"; then
    echo "✗ migration.sql failed to apply: $name"
    cat "$WORK/up.err"
    failed=1
    continue
  fi

  if ! psql_run -f "$dir/down.sql" >/dev/null 2>"$WORK/down.err"; then
    echo "✗ down.sql failed to apply after the migration: $name"
    cat "$WORK/down.err"
    failed=1
    continue
  fi
  dump_schema "$WORK/after.sql"

  if diff -u "$WORK/before.sql" "$WORK/after.sql" >"$WORK/diff.txt"; then
    echo "✓ $name"
  else
    echo "✗ rollback of $name does not restore the pre-migration schema state:"
    cat "$WORK/diff.txt"
    failed=1
  fi
done

if [[ $failed -ne 0 ]]; then
  echo "Migration rollback verification FAILED"
  exit 1
fi

echo "All verifiable migration rollbacks restore the pre-migration schema state."
