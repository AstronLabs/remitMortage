#!/usr/bin/env bash
#
# CORS Policy Drift Detector
#
# Compares the documented/intended CORS allow-list (backend/config/allowed-origins.json)
# against what a live deployment actually allows, by sending real preflight
# requests. Two kinds of drift are caught:
#
#   1. Missing:      a documented origin is no longer allowed (someone removed
#                     it, or broke it, without updating the docs).
#   2. Unauthorized:  the server allows an origin that isn't documented, or
#                     reflects/allows a wildcard-like probe origin — e.g. a
#                     manually-added debugging origin or an overly permissive
#                     CORS setting that landed in production unnoticed.
#
# Usage:
#   ./backend/scripts/detect-cors-drift.sh --target-url=https://api.remitmortgage.com --environment=production
#   CORS_DRIFT_TARGET_URL=https://api.remitmortgage.com ./backend/scripts/detect-cors-drift.sh
#
# Exit codes:
#   0 = no drift (deployed CORS config matches the documented list)
#   1 = error (couldn't reach target, malformed config, etc.)
#   2 = drift detected (also prints a diff-style summary)
#
# Artifacts:
#   Writes cors-drift-summary.txt in the current directory when drift is found,
#   for upload as a CI artifact.

set -euo pipefail

# ── Resolve paths ────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

CONFIG_FILE="$BACKEND_DIR/config/allowed-origins.json"
HEALTH_PATH="/api/health"

# ── Defaults / flags ─────────────────────────────────────────────────────
TARGET_URL="${CORS_DRIFT_TARGET_URL:-}"
ENVIRONMENT="${CORS_DRIFT_ENVIRONMENT:-production}"
OUTPUT_DIR="."
SHOW_HELP=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-url=*) TARGET_URL="${1#*=}"; shift ;;
    --target-url) TARGET_URL="$2"; shift 2 ;;
    --environment=*) ENVIRONMENT="${1#*=}"; shift ;;
    --environment) ENVIRONMENT="$2"; shift 2 ;;
    --config=*) CONFIG_FILE="${1#*=}"; shift ;;
    --output-dir=*) OUTPUT_DIR="${1#*=}"; shift ;;
    -h|--help) SHOW_HELP=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ "$SHOW_HELP" == true ]]; then
  cat <<'EOF'
CORS Policy Drift Detector

Usage:
  detect-cors-drift.sh --target-url=URL [options]

Options:
  --target-url=URL      Base URL of the deployed API to probe (required; or set CORS_DRIFT_TARGET_URL)
  --environment=ENV     Key into config/allowed-origins.json (default: production)
  --config=PATH         Path to the documented origins file (default: backend/config/allowed-origins.json)
  --output-dir=DIR      Where to write cors-drift-summary.txt on drift (default: .)
  -h, --help            Show this help

Examples:
  ./backend/scripts/detect-cors-drift.sh --target-url=https://api.remitmortgage.com --environment=production
  CORS_DRIFT_TARGET_URL=https://staging-api.remitmortgage.com ./backend/scripts/detect-cors-drift.sh --environment=staging
EOF
  exit 0
fi

if [[ -z "$TARGET_URL" ]]; then
  echo "Error: --target-url (or CORS_DRIFT_TARGET_URL) is required." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required." >&2
  exit 1
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: documented origins file not found at $CONFIG_FILE" >&2
  exit 1
fi

TARGET_URL="${TARGET_URL%/}"
PROBE_URL="${TARGET_URL}${HEALTH_PATH}"

mapfile -t DOCUMENTED_ORIGINS < <(jq -r --arg env "$ENVIRONMENT" '.[$env][]? // empty' "$CONFIG_FILE")

if [[ "${#DOCUMENTED_ORIGINS[@]}" -eq 0 ]]; then
  echo "Error: no documented origins found for environment '$ENVIRONMENT' in $CONFIG_FILE" >&2
  exit 1
fi

# Fetches the Access-Control-Allow-Origin header the server returns for a
# preflight request from the given Origin. Empty string if not allowed.
probe_origin() {
  local origin="$1"
  curl -s -o /dev/null -D - \
    -X OPTIONS \
    -H "Origin: ${origin}" \
    -H "Access-Control-Request-Method: GET" \
    --max-time 10 \
    "$PROBE_URL" \
    | tr -d '\r' \
    | grep -i '^access-control-allow-origin:' \
    | sed -E 's/^[Aa]ccess-[Cc]ontrol-[Aa]llow-[Oo]rigin: ?//' \
    | tail -n1
}

MISSING=()
UNAUTHORIZED=()

echo "Probing ${PROBE_URL} for CORS drift against '${ENVIRONMENT}' (${#DOCUMENTED_ORIGINS[@]} documented origin(s))..."

# 1. Every documented origin must be allowed.
for origin in "${DOCUMENTED_ORIGINS[@]}"; do
  allowed="$(probe_origin "$origin" || true)"
  if [[ "$allowed" != "$origin" ]]; then
    MISSING+=("$origin")
  fi
done

# 2. An undocumented, randomly-generated origin must NOT be allowed. Catches
#    an overly permissive wildcard ("*") or a misconfigured reflect-any-origin setup.
CANARY_ORIGIN="https://cors-drift-canary-$(date +%s%N 2>/dev/null || echo $RANDOM).invalid"
canary_allowed="$(probe_origin "$CANARY_ORIGIN" || true)"
if [[ "$canary_allowed" == "$CANARY_ORIGIN" || "$canary_allowed" == "*" ]]; then
  UNAUTHORIZED+=("$CANARY_ORIGIN (server responded: ${canary_allowed})")
fi

# 3. Known debugging/local origins should never be allowed outside development.
if [[ "$ENVIRONMENT" != "development" ]]; then
  for debug_origin in "http://localhost:3000" "http://localhost:4000" "http://127.0.0.1:3000"; do
    debug_allowed="$(probe_origin "$debug_origin" || true)"
    if [[ "$debug_allowed" == "$debug_origin" ]]; then
      UNAUTHORIZED+=("$debug_origin (localhost origin allowed in ${ENVIRONMENT})")
    fi
  done
fi

if [[ "${#MISSING[@]}" -eq 0 && "${#UNAUTHORIZED[@]}" -eq 0 ]]; then
  echo "No CORS drift detected. Deployed configuration matches ${CONFIG_FILE} (${ENVIRONMENT})."
  exit 0
fi

SUMMARY_FILE="${OUTPUT_DIR}/cors-drift-summary.txt"
{
  echo "CORS Policy Drift Detected"
  echo "Target:      ${TARGET_URL}"
  echo "Environment: ${ENVIRONMENT}"
  echo "Documented:  ${CONFIG_FILE}"
  echo ""
  if [[ "${#MISSING[@]}" -gt 0 ]]; then
    echo "Documented origins the deployment no longer allows:"
    for origin in "${MISSING[@]}"; do
      echo "  - ${origin}"
    done
    echo ""
  fi
  if [[ "${#UNAUTHORIZED[@]}" -gt 0 ]]; then
    echo "Origins the deployment allows that are not documented / should never be allowed:"
    for entry in "${UNAUTHORIZED[@]}"; do
      echo "  - ${entry}"
    done
  fi
} | tee "$SUMMARY_FILE" >&2

exit 2
