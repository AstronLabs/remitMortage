#!/bin/bash
#
# Backup encryption key rotation verification.
#
# The monthly restore drill (scripts/verify-backup-restore.sh) proves a backup
# can be restored, but says nothing about *which* encryption key produced it.
# A stuck rotation — the key management process silently failing to roll
# BACKUP_ENCRYPTION_KEY forward — would leave every backup encrypted under the
# same aging key indefinitely, with the restore drill still passing the whole
# time.
#
# This script inspects the most recently uploaded backup object in cloud
# storage and checks the encryption key metadata that
# backend/src/services/databaseBackup.ts stamps onto every backup at upload
# time (see docs/SECRETS_ROTATION.md, "Backup encryption key"):
#
#   1. The key that produced it is no older than BACKUP_KEY_ROTATION_INTERVAL_DAYS.
#   2. If EXPECTED_ENCRYPTION_KEY_ID is set, the backup was actually encrypted
#      under that key id (catches rotation that updated the secret but never
#      reached the backup job).
#
# Usage:
#   BACKUP_BUCKET=remitmortgage-backups \
#     ./scripts/verify-backup-key-rotation.sh
#
# Environment:
#   BACKUP_BUCKET                      S3 bucket the backups live in. Required.
#   BACKUP_PREFIX                      Key prefix to search. Default: backups/
#   BACKUP_KEY_ROTATION_INTERVAL_DAYS  Max allowed key age. Default: 90
#   EXPECTED_ENCRYPTION_KEY_ID          Optional: the key id currently on file
#                                       in the secret store, to check the
#                                       backup actually used it.
#   REPORT_PATH                        Optional path for the summary.

set -euo pipefail

BACKUP_BUCKET="${BACKUP_BUCKET:-}"
BACKUP_PREFIX="${BACKUP_PREFIX:-backups/}"
ROTATION_INTERVAL_DAYS="${BACKUP_KEY_ROTATION_INTERVAL_DAYS:-90}"
EXPECTED_ENCRYPTION_KEY_ID="${EXPECTED_ENCRYPTION_KEY_ID:-}"
REPORT_PATH="${REPORT_PATH:-backup-key-rotation-report.txt}"

if [[ -z "$BACKUP_BUCKET" ]]; then
  echo "❌ BACKUP_BUCKET must be set." >&2
  exit 2
fi

if ! command -v aws &> /dev/null; then
  echo "❌ Required binary 'aws' not found on PATH." >&2
  exit 2
fi

echo "=========================================="
echo "🔑 Backup Encryption Key Rotation Check"
echo "=========================================="
echo "Bucket: s3://$BACKUP_BUCKET/$BACKUP_PREFIX"

echo ""
echo "▶ Locating most recent backup..."
LATEST_KEY="$(aws s3api list-objects-v2 \
  --bucket "$BACKUP_BUCKET" \
  --prefix "$BACKUP_PREFIX" \
  --query 'sort_by(Contents, &LastModified)[-1].Key' \
  --output text)"

FAILURES=()

if [[ -z "$LATEST_KEY" || "$LATEST_KEY" == "None" ]]; then
  echo "❌ No backup objects found under s3://$BACKUP_BUCKET/$BACKUP_PREFIX." >&2
  FAILURES+=("no backup objects found")
  KEY_ID=""
  ROTATED_AT=""
  AGE_DAYS=""
else
  echo "  latest backup: $LATEST_KEY"

  echo ""
  echo "▶ Reading encryption key metadata..."
  METADATA_JSON="$(aws s3api head-object --bucket "$BACKUP_BUCKET" --key "$LATEST_KEY")"
  KEY_ID="$(echo "$METADATA_JSON" | grep -o '"encryptionkeyid"[^,}]*' | sed -E 's/.*: *"?([^"]*)"?/\1/' || true)"
  ROTATED_AT="$(echo "$METADATA_JSON" | grep -o '"encryptionkeyrotatedat"[^,}]*' | sed -E 's/.*: *"?([^"]*)"?/\1/' || true)"

  echo "  encryptionKeyId=${KEY_ID:-<missing>}"
  echo "  encryptionKeyRotatedAt=${ROTATED_AT:-<missing>}"

  if [[ -z "$ROTATED_AT" ]]; then
    FAILURES+=("most recent backup ($LATEST_KEY) has no encryptionKeyRotatedAt metadata — cannot verify rotation")
    AGE_DAYS=""
  else
    ROTATED_AT_EPOCH="$(date -u -d "$ROTATED_AT" +%s 2>/dev/null || true)"
    NOW_EPOCH="$(date -u +%s)"

    if [[ -z "$ROTATED_AT_EPOCH" ]]; then
      FAILURES+=("encryptionKeyRotatedAt '$ROTATED_AT' on $LATEST_KEY is not a parseable timestamp")
      AGE_DAYS=""
    else
      AGE_DAYS=$(( (NOW_EPOCH - ROTATED_AT_EPOCH) / 86400 ))
      echo "  key age: ${AGE_DAYS} day(s) (limit: ${ROTATION_INTERVAL_DAYS})"

      if (( AGE_DAYS > ROTATION_INTERVAL_DAYS )); then
        FAILURES+=("encryption key active for the most recent backup is ${AGE_DAYS} day(s) old, exceeding the ${ROTATION_INTERVAL_DAYS}-day rotation policy — rotation may be stuck")
      fi
    fi
  fi

  if [[ -n "$EXPECTED_ENCRYPTION_KEY_ID" ]]; then
    if [[ -z "$KEY_ID" ]]; then
      FAILURES+=("most recent backup ($LATEST_KEY) has no encryptionKeyId metadata to compare against expected '$EXPECTED_ENCRYPTION_KEY_ID'")
    elif [[ "$KEY_ID" != "$EXPECTED_ENCRYPTION_KEY_ID" ]]; then
      FAILURES+=("most recent backup was encrypted with key id '$KEY_ID', expected the current key '$EXPECTED_ENCRYPTION_KEY_ID' — rotation did not reach the backup job")
    fi
  fi
fi

CHECKED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

{
  echo "Backup Encryption Key Rotation Verification"
  echo "============================================"
  echo "checked_at=$CHECKED_AT"
  echo "bucket=$BACKUP_BUCKET"
  echo "latest_backup=${LATEST_KEY:-none}"
  echo "encryption_key_id=${KEY_ID:-unknown}"
  echo "encryption_key_rotated_at=${ROTATED_AT:-unknown}"
  echo "encryption_key_age_days=${AGE_DAYS:-unknown}"
  echo "rotation_interval_days=$ROTATION_INTERVAL_DAYS"
  if [[ ${#FAILURES[@]} -eq 0 ]]; then
    echo "result=PASS"
  else
    echo "result=FAIL"
    for failure in "${FAILURES[@]}"; do
      echo "failure=$failure"
    done
  fi
} | tee "$REPORT_PATH"

echo ""
if [[ ${#FAILURES[@]} -gt 0 ]]; then
  echo "=========================================="
  echo "❌ Backup key rotation check FAILED"
  echo "=========================================="
  for failure in "${FAILURES[@]}"; do
    echo "  - $failure" >&2
  done
  exit 1
fi

echo "=========================================="
echo "✅ Backup key rotation check PASSED"
echo "   key age: ${AGE_DAYS} day(s), within the ${ROTATION_INTERVAL_DAYS}-day policy"
echo "=========================================="
