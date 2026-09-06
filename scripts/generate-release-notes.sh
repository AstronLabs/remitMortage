#!/usr/bin/env bash
# Generate release notes locally from conventional commit history.
# Usage:
#   ./scripts/generate-release-notes.sh            # notes since last tag
#   ./scripts/generate-release-notes.sh v1.2.0     # notes for a specific tag range

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TAG="${1:-}"
if [ -z "$TAG" ]; then
  TAG="$(git describe --tags --abbrev=0 2>/dev/null || echo HEAD)"
  RANGE="${TAG}"
else
  PREV_TAG="$(git describe --tags --abbrev=0 "${TAG}^" 2>/dev/null || true)"
  if [ -n "$PREV_TAG" ]; then
    RANGE="${PREV_TAG}..${TAG}"
  else
    RANGE="${TAG}"
  fi
fi

echo "Generating release notes for: ${RANGE}"
npx --yes conventional-changelog-cli@4.1.0 \
  -n .github/changelog-config.cjs \
  -r 1 \
  --commit-path . \
  "${RANGE}"
