#!/usr/bin/env bash
# Upgrade dry run for the lending pool: replays stored state against a candidate
# wasm before an upgrade is proposed. See contracts/lending-pool/README.md.
#
# Usage:
#   scripts/upgrade-dry-run.sh [BASE_REF]
#
#   BASE_REF   Git ref of the code that is deployed today (default: origin/main).
#              Its wasm is built in a temporary worktree and becomes the baseline.
#
# Environment:
#   BASE_WASM  Use this wasm file as the baseline instead of building BASE_REF
#              (e.g. the wasm currently on chain).
#
# The candidate is the wasm built from the current working tree.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_REF="${1:-origin/main}"
TARGET="wasm32v1-none"
WASM_NAME="lending_pool.wasm"

TMP="$(mktemp -d)"
WORKTREE=""
cleanup() {
  if [ -n "$WORKTREE" ]; then
    git -C "$ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "==> Building candidate wasm from the working tree"
(cd "$ROOT/contracts" && cargo build --target "$TARGET" --release -p lending-pool)
cp "$ROOT/contracts/target/$TARGET/release/$WASM_NAME" "$TMP/candidate.wasm"

if [ -n "${BASE_WASM:-}" ]; then
  echo "==> Using baseline wasm $BASE_WASM"
  cp "$BASE_WASM" "$TMP/base.wasm"
else
  echo "==> Building baseline wasm from $BASE_REF"
  WORKTREE="$TMP/base-src"
  git -C "$ROOT" worktree add --detach "$WORKTREE" "$BASE_REF" >/dev/null
  # Reuse one target dir between runs so dependencies are not rebuilt each time.
  (cd "$WORKTREE/contracts" &&
    CARGO_TARGET_DIR="$ROOT/contracts/target/upgrade-dry-run-base" \
      cargo build --target "$TARGET" --release -p lending-pool)
  cp "$ROOT/contracts/target/upgrade-dry-run-base/$TARGET/release/$WASM_NAME" "$TMP/base.wasm"
fi

echo "==> Running the dry run"
(cd "$ROOT/contracts" &&
  UPGRADE_DRY_RUN_BASE_WASM="$TMP/base.wasm" \
  UPGRADE_DRY_RUN_CANDIDATE_WASM="$TMP/candidate.wasm" \
    cargo test -p lending-pool --test upgrade_dry_run -- --ignored --nocapture)

echo "==> Dry run passed: existing state reads identically after the upgrade"
