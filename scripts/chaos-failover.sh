#!/usr/bin/env bash
set -euo pipefail

: "${PRIMARY_CONTROL_URL:?PRIMARY_CONTROL_URL is required}"
: "${FAILOVER_HOST:?FAILOVER_HOST is required}"
: "${FAILOVER_EXPECTED_MARKER:?FAILOVER_EXPECTED_MARKER is required}"
RTO_TARGET_SECONDS="${RTO_TARGET_SECONDS:-120}"

if [[ "${CHAOS_ENVIRONMENT:-}" != "staging" ]]; then
  echo "Refusing chaos run: CHAOS_ENVIRONMENT must be staging" >&2
  exit 2
fi

started_at=$(date +%s)
restore() {
  curl --fail --silent --show-error -X POST "${PRIMARY_CONTROL_URL%/}/restore" >/dev/null || true
}
trap restore EXIT

curl --fail --silent --show-error -X POST "${PRIMARY_CONTROL_URL%/}/block-health-check" >/dev/null

echo "Primary health check disabled at ${started_at}; polling ${FAILOVER_HOST}"
while true; do
  now=$(date +%s)
  elapsed=$((now - started_at))
  if curl --fail --silent --show-error "${FAILOVER_HOST%/}/health" | grep -Fq "$FAILOVER_EXPECTED_MARKER"; then
    printf '{"startedAt":%s,"recoveredAt":%s,"recoverySeconds":%s,"rtoTargetSeconds":%s}\n' \
      "$started_at" "$now" "$elapsed" "$RTO_TARGET_SECONDS" | tee failover-result.json
    if (( elapsed > RTO_TARGET_SECONDS )); then
      echo "Failover exceeded RTO target" >&2
      exit 1
    fi
    exit 0
  fi
  if (( elapsed >= RTO_TARGET_SECONDS )); then
    echo "Failover did not recover within ${RTO_TARGET_SECONDS}s" >&2
    exit 1
  fi
  sleep 5
done
