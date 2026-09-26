#!/usr/bin/env bash
# Copyright (c) 2026 RemitMortgage Protocol Contributors
# SPDX-License-Identifier: MIT
#
# dr-drill.sh — Database layer disaster recovery measurement script.
#
# What this does
# ──────────────
# 1. Takes a pg_dump of the primary database (simulating a production backup).
# 2. Restores the dump into the replica/standby database (simulating failover).
# 3. Validates schema integrity and key record counts.
# 4. Records the wall-clock RTO (dump + restore + validation time).
# 5. Estimates RPO from the RPO_BASELINE_TS env var set before the seed.
# 6. Writes both values to GITHUB_OUTPUT for the gate job.
# 7. Appends a detailed report to REPORT_PATH.
#
# Environment variables (required)
# ─────────────────────────────────
#   PRIMARY_DB_URL       – PostgreSQL DSN for the source (primary) database
#   REPLICA_DB_URL       – PostgreSQL DSN for the target (replica) database
#   RPO_BASELINE_TS      – Unix epoch when data was last known-good (from seed)
#   RTO_TARGET_SECONDS   – Numeric RTO threshold (informational here; gate job enforces)
#   RPO_TARGET_MINUTES   – Numeric RPO threshold (informational here)
#   REPORT_PATH          – Path to append the drill report to

set -euo pipefail

: "${PRIMARY_DB_URL:?PRIMARY_DB_URL must be set}"
: "${REPLICA_DB_URL:?REPLICA_DB_URL must be set}"
: "${RPO_BASELINE_TS:?RPO_BASELINE_TS must be set}"
: "${REPORT_PATH:=dr-drill-report.txt}"

DUMP_FILE="$(mktemp /tmp/dr-drill-XXXXXX.dump)"
DRILL_START=$(date +%s)

log() { echo "[$(date -u '+%H:%M:%S')] $*"; }

cleanup() {
  rm -f "$DUMP_FILE"
}
trap cleanup EXIT

# ── 1. Dump primary ───────────────────────────────────────────────────────────
log "Step 1/4 — Dumping primary database..."
DUMP_START=$(date +%s)
pg_dump --format=custom --no-owner --no-acl \
  "${PRIMARY_DB_URL}" \
  --file="${DUMP_FILE}"
DUMP_ELAPSED=$(( $(date +%s) - DUMP_START ))
log "  Dump complete in ${DUMP_ELAPSED}s ($(du -sh "$DUMP_FILE" | cut -f1))"

# ── 2. Restore to replica ─────────────────────────────────────────────────────
log "Step 2/4 — Restoring dump to replica database..."
RESTORE_START=$(date +%s)
pg_restore --no-owner --no-acl --clean --if-exists \
  --dbname="${REPLICA_DB_URL}" \
  "${DUMP_FILE}" 2>&1 | grep -v "^pg_restore: warning:" || true
RESTORE_ELAPSED=$(( $(date +%s) - RESTORE_START ))
log "  Restore complete in ${RESTORE_ELAPSED}s"

# ── 3. Validate schema and row counts ─────────────────────────────────────────
log "Step 3/4 — Validating restored schema..."
VALIDATION_OK=true

# Extract connection params from DSN for psql
run_sql() {
  psql "${REPLICA_DB_URL}" -t -c "$1" 2>&1
}

# Check that core tables exist in the replica
CORE_TABLES=("users" "loans" "milestones" "audit_logs" "transactions")
for TABLE in "${CORE_TABLES[@]}"; do
  COUNT=$(run_sql "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='${TABLE}';" | xargs)
  if [ "$COUNT" = "0" ]; then
    log "  ✗ Table '${TABLE}' not found in replica"
    VALIDATION_OK=false
  else
    # Compare row counts between primary and replica
    PRIMARY_ROWS=$(psql "${PRIMARY_DB_URL}" -t -c "SELECT COUNT(*) FROM \"${TABLE}\";" 2>/dev/null | xargs || echo "N/A")
    REPLICA_ROWS=$(run_sql "SELECT COUNT(*) FROM \"${TABLE}\";" | xargs || echo "N/A")
    if [ "$PRIMARY_ROWS" = "$REPLICA_ROWS" ]; then
      log "  ✓ Table '${TABLE}': ${REPLICA_ROWS} rows match"
    else
      log "  ✗ Table '${TABLE}' row count mismatch — primary: ${PRIMARY_ROWS}, replica: ${REPLICA_ROWS}"
      VALIDATION_OK=false
    fi
  fi
done

# ── 4. Compute RTO and RPO ────────────────────────────────────────────────────
log "Step 4/4 — Computing RTO / RPO..."
DRILL_END=$(date +%s)
RTO_SECONDS=$(( DRILL_END - DRILL_START ))
RPO_MINUTES=$(( ( DRILL_END - RPO_BASELINE_TS ) / 60 ))

log "  RTO: ${RTO_SECONDS}s (target: ≤${RTO_TARGET_SECONDS:-300}s)"
log "  RPO: ${RPO_MINUTES} min (target: ≤${RPO_TARGET_MINUTES:-15} min)"

if [ "$VALIDATION_OK" = "false" ]; then
  VERIFIED="false"
  log "✗ Validation FAILED — replica is not consistent with primary"
else
  VERIFIED="true"
  log "✓ Replica validation PASSED"
fi

# ── Write GITHUB_OUTPUT ───────────────────────────────────────────────────────
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "rto_seconds=${RTO_SECONDS}" >> "$GITHUB_OUTPUT"
  echo "rpo_minutes=${RPO_MINUTES}" >> "$GITHUB_OUTPUT"
  echo "verified=${VERIFIED}" >> "$GITHUB_OUTPUT"
fi

# ── Append detailed report ────────────────────────────────────────────────────
{
  echo ""
  echo "=== Database Layer Drill Detail ==="
  echo "Started    : $(date -u -d @${DRILL_START} 2>/dev/null || date -u -r ${DRILL_START})"
  echo "Finished   : $(date -u -d @${DRILL_END} 2>/dev/null || date -u -r ${DRILL_END})"
  echo "Dump time  : ${DUMP_ELAPSED}s"
  echo "Restore    : ${RESTORE_ELAPSED}s"
  echo "Total RTO  : ${RTO_SECONDS}s"
  echo "RPO est.   : ${RPO_MINUTES} min"
  echo "Validation : ${VERIFIED}"
} >> "${REPORT_PATH}"

if [ "$VERIFIED" = "false" ]; then
  exit 1
fi
