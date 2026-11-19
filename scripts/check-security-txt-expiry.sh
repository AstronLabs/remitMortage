#!/bin/bash
#
# security.txt expiry monitor (RFC 9116).
#
# An expired `Expires` field in security.txt is a silent trust problem: it
# signals to researchers' tooling that the disclosure policy is unmaintained,
# so reports stop arriving through the intended channel. This check fetches
# the live security.txt, validates it parses, and fails (exit 1) once it is
# inside the renewal warning window, already expired, or unreachable/malformed
# — so CI can raise an alert while there is still time to renew it.
#
# Usage:
#   ./scripts/check-security-txt-expiry.sh
#
# Source (first available wins, for the live check):
#   SECURITY_TXT_URL        default https://remitmortgage.com/.well-known/security.txt
#
# For --check-config, the LOCAL file is always used (no network access):
#   SECURITY_TXT_LOCAL_PATH default frontend/public/.well-known/security.txt
#
# Environment:
#   SECURITYTXT_WARN_DAYS   Renewal warning window in days (default 30).
#   SECURITYTXT_CONNECT_TIMEOUT  Fetch timeout in seconds (default 15).
#   SECURITYTXT_REPORT_PATH Path for the machine-readable summary
#                           (default security-txt-expiry-report.txt).
#
# Flags:
#   --check-config          Parse and validate the local file only. Makes no
#                           network connections and exits 0 on a valid file
#                           with a non-expired `Expires` (used by the
#                           workflow's pull_request guard).

set -euo pipefail

CHECK_CONFIG_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check-config) CHECK_CONFIG_ONLY=1 ;;
    *) echo "❌ Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

WARN_DAYS="${SECURITYTXT_WARN_DAYS:-30}"
CONNECT_TIMEOUT="${SECURITYTXT_CONNECT_TIMEOUT:-15}"
REPORT_PATH="${SECURITYTXT_REPORT_PATH:-security-txt-expiry-report.txt}"
LOCAL_PATH="${SECURITY_TXT_LOCAL_PATH:-frontend/public/.well-known/security.txt}"
LIVE_URL="${SECURITY_TXT_URL:-https://remitmortgage.com/.well-known/security.txt}"

if ! [[ "$WARN_DAYS" =~ ^[0-9]+$ ]]; then
  echo "❌ SECURITYTXT_WARN_DAYS must be a non-negative integer (got '$WARN_DAYS')." >&2
  exit 2
fi

for binary in date grep sed; do
  if ! command -v "$binary" &> /dev/null; then
    echo "❌ Required binary '$binary' not found on PATH." >&2
    exit 2
  fi
done

# Portable "date string -> epoch seconds" (GNU date vs BSD/macOS date).
to_epoch() {
  local when="$1"
  date -u -d "$when" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%S" "${when%%.*}" +%s 2>/dev/null
}

# Extracts the value of a single-occurrence RFC 9116 field (first match wins;
# the spec allows repeated `Contact` lines but `Expires`/`Encryption`/`Policy`
# are each expected exactly once).
field() {
  local name="$1" content="$2"
  printf '%s\n' "$content" | grep -i "^${name}:" | head -n1 | sed -E "s/^${name}:[[:space:]]*//I" | tr -d '\r'
}

validate_content() {
  local content="$1" source_label="$2"

  if [[ -z "$(printf '%s' "$content" | tr -d '[:space:]')" ]]; then
    echo "MALFORMED|0|empty content"
    return
  fi

  local expires
  expires="$(field "Expires" "$content")"
  if [[ -z "$expires" ]]; then
    echo "MALFORMED|0|no Expires field"
    return
  fi

  local contact
  contact="$(field "Contact" "$content")"
  if [[ -z "$contact" ]]; then
    echo "MALFORMED|0|no Contact field"
    return
  fi

  local expiry_epoch
  expiry_epoch="$(to_epoch "$expires" || true)"
  if [[ -z "${expiry_epoch:-}" ]]; then
    echo "MALFORMED|0|unparseable Expires value '${expires}'"
    return
  fi

  local now_epoch days_left
  now_epoch="$(date -u +%s)"
  days_left=$(( (expiry_epoch - now_epoch) / 86400 ))

  if (( expiry_epoch <= now_epoch )); then
    echo "EXPIRED|${days_left}|${expires}"
  elif (( days_left <= WARN_DAYS )); then
    echo "EXPIRING|${days_left}|${expires}"
  else
    echo "OK|${days_left}|${expires}"
  fi
}

if [[ "$CHECK_CONFIG_ONLY" -eq 1 ]]; then
  if [[ ! -f "$LOCAL_PATH" ]]; then
    echo "❌ Local security.txt not found at '$LOCAL_PATH'." >&2
    exit 2
  fi
  content="$(cat "$LOCAL_PATH")"
  result="$(validate_content "$content" "local")"
  IFS='|' read -r state days_left expires <<< "$result"
  case "$state" in
    MALFORMED)
      echo "❌ ${LOCAL_PATH} is malformed: ${expires}" >&2
      exit 1
      ;;
    EXPIRED)
      echo "❌ ${LOCAL_PATH} Expires (${expires}) is already in the past." >&2
      exit 1
      ;;
    *)
      echo "✅ ${LOCAL_PATH} parses and expires ${expires} (${days_left}d from now)."
      exit 0
      ;;
  esac
fi

STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "=========================================="
echo "🔐 security.txt Expiry Monitor"
echo "=========================================="
echo "Started:        $STARTED_AT"
echo "Source:         $LIVE_URL"
echo "Warning window: ${WARN_DAYS} day(s)"
echo ""

run_with_timeout() {
  local secs="$1"; shift
  if command -v timeout &> /dev/null; then
    timeout "$secs" "$@"
  else
    "$@"
  fi
}

: > "$REPORT_PATH"
{
  echo "# security.txt expiry report"
  echo "generated_at=$STARTED_AT"
  echo "warn_days=$WARN_DAYS"
  echo "# source<TAB>days_left<TAB>state<TAB>expires<TAB>error"
} >> "$REPORT_PATH"

http_body=""
http_status=""
if command -v curl &> /dev/null; then
  http_response="$(run_with_timeout "$CONNECT_TIMEOUT" curl -fsS -w '\n%{http_code}' "$LIVE_URL" 2>/dev/null || true)"
  http_status="$(printf '%s\n' "$http_response" | tail -n1)"
  http_body="$(printf '%s\n' "$http_response" | sed '$d')"
else
  echo "❌ curl not found on PATH." >&2
  exit 2
fi

if [[ -z "$http_body" || "$http_status" != "200" ]]; then
  echo "  ✗ ${LIVE_URL} — unreachable (HTTP ${http_status:-NA})"
  printf '%s\t%s\t%s\t%s\t%s\n' "$LIVE_URL" "NA" "UNREACHABLE" "NA" "HTTP ${http_status:-NA}" >> "$REPORT_PATH"
  echo "" >> "$REPORT_PATH"
  echo "summary_state=UNREACHABLE" >> "$REPORT_PATH"
  echo ""
  echo "❌ Could not retrieve ${LIVE_URL}."
  exit 1
fi

result="$(validate_content "$http_body" "live")"
IFS='|' read -r state days_left expires <<< "$result"

case "$state" in
  OK)
    echo "  ✓ ${LIVE_URL} — ${days_left}d left, expires ${expires}"
    printf '%s\t%s\t%s\t%s\t%s\n' "$LIVE_URL" "$days_left" "$state" "$expires" "-" >> "$REPORT_PATH"
    ;;
  EXPIRING|EXPIRED)
    echo "  ⚠ ${LIVE_URL} — ${state}: ${days_left}d left, expires ${expires}. Renew via devops/SECURITY_TXT_RENEWAL.md"
    printf '%s\t%s\t%s\t%s\t%s\n' "$LIVE_URL" "$days_left" "$state" "$expires" "-" >> "$REPORT_PATH"
    ;;
  MALFORMED)
    echo "  ✗ ${LIVE_URL} — MALFORMED: ${expires}"
    printf '%s\t%s\t%s\t%s\t%s\n' "$LIVE_URL" "NA" "MALFORMED" "NA" "$expires" >> "$REPORT_PATH"
    ;;
esac

echo "" >> "$REPORT_PATH"
echo "summary_state=${state}" >> "$REPORT_PATH"

echo ""
echo "------------------------------------------"
echo "Report written to ${REPORT_PATH}"

if [[ "$state" == "OK" ]]; then
  echo "✅ security.txt is outside the ${WARN_DAYS}-day renewal window."
  exit 0
fi

exit 1
