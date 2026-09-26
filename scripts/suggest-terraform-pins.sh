#!/usr/bin/env bash
# Copyright (c) 2026 RemitMortgage Protocol Contributors
# SPDX-License-Identifier: MIT
#
# suggest-terraform-pins.sh
#
# Auto-fix suggestion tool: for each unpinned provider/module found by
# check-terraform-pinning.mjs, queries the Terraform Registry for the
# latest published version and prints a ready-to-apply sed command.
#
# Usage
#   bash scripts/suggest-terraform-pins.sh [<repo-root>]
#
# Requirements
#   curl, jq (both available in standard CI runners)
#
# This script ONLY prints suggestions — it never edits files.
# Apply the suggested change manually, commit, and re-run the CI check.

set -euo pipefail

REPO_ROOT="${1:-$(pwd)}"
REGISTRY_API="https://registry.terraform.io/v1"
SKIP_DIRS=(".git" "node_modules" ".terraform" "dist" "build" "coverage" ".next" "target")

log()  { echo "[suggest-pins] $*"; }
warn() { echo "[suggest-pins] ⚠  $*" >&2; }

# ── Helpers ───────────────────────────────────────────────────────────────────

is_exact_pin() {
  local version="$1"
  [[ "$version" =~ ^=?[[:space:]]*[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

is_registry_source() {
  local source="$1"
  [[ ! "$source" =~ ^(\.\.?/|git::|github\.com|bitbucket\.org|https?://) ]]
}

# Build a find command that excludes skip dirs
build_find_args() {
  local args=("$REPO_ROOT" -type f -name "*.tf")
  for d in "${SKIP_DIRS[@]}"; do
    args+=(-not -path "*/${d}/*")
  done
  printf '%q ' "${args[@]}"
}

# Fetch the latest version of a Terraform provider from the registry
fetch_provider_latest() {
  local namespace_type="$1"   # e.g. "hashicorp/aws"
  local namespace provider
  namespace=$(echo "$namespace_type" | cut -d/ -f1)
  provider=$(echo "$namespace_type" | cut -d/ -f2)
  curl -sf "${REGISTRY_API}/providers/${namespace}/${provider}" \
    | jq -r '.version // empty' 2>/dev/null || echo ""
}

# Fetch the latest version of a Terraform module from the registry
fetch_module_latest() {
  local source="$1"   # e.g. "terraform-aws-modules/vpc/aws"
  curl -sf "${REGISTRY_API}/modules/${source}" \
    | jq -r '.version // empty' 2>/dev/null || echo ""
}

# ── Main scan ─────────────────────────────────────────────────────────────────

log "Scanning ${REPO_ROOT} for unpinned Terraform sources..."

TF_FILES=()
while IFS= read -r -d '' f; do
  TF_FILES+=("$f")
done < <(eval "find $(build_find_args)" -print0 2>/dev/null)

if [ "${#TF_FILES[@]}" -eq 0 ]; then
  log "No .tf files found."
  exit 0
fi

FOUND=0

for FILE in "${TF_FILES[@]}"; do
  REL="${FILE#"$REPO_ROOT"/}"

  # ── Providers ────────────────────────────────────────────────────────────
  # Extract: label, source, version from required_providers entries
  # We use awk to find multi-line blocks
  while IFS='|' read -r label source version; do
    [ -z "$label" ] && continue
    if ! is_exact_pin "$version"; then
      FOUND=$((FOUND + 1))
      log "Unpinned provider: ${REL} → ${label} (source: ${source}, current: \"${version:-<missing>}\")"

      LATEST=$(fetch_provider_latest "$source" 2>/dev/null || echo "")
      if [ -n "$LATEST" ]; then
        echo ""
        echo "  Suggested fix for '${label}' in ${REL}:"
        echo "    # Replace the current version constraint with the exact latest:"
        if [ -n "$version" ]; then
          printf '    sed -i '"'"'s|version = "%s"|version = "= %s"|g'"'"' "%s"\n' \
            "$version" "$LATEST" "$FILE"
        else
          echo "    # Add version = \"= ${LATEST}\" inside the ${label} provider block"
        fi
        echo ""
      else
        warn "Could not fetch latest version for provider ${source} — pin manually."
      fi
    fi
  done < <(
    # AWK: extract label|source|version triples from required_providers blocks
    awk '
      /required_providers/ { in_block=1; depth=0 }
      in_block {
        if (/\{/) depth++
        if (/\}/) { depth--; if (depth<=0) { in_block=0 } }
      }
      in_block && /[a-z][a-z0-9_-]*[[:space:]]*=/ && !/required_providers/ {
        label=$1
      }
      in_block && /source[[:space:]]*=/ {
        match($0, /"([^"]+)"/, arr); src=arr[1]
      }
      in_block && /version[[:space:]]*=/ {
        match($0, /"([^"]+)"/, arr); ver=arr[1]
        if (label != "" && src != "") {
          print label "|" src "|" ver
          label=""; src=""; ver=""
        }
      }
    ' "$FILE"
  )

  # ── Modules ──────────────────────────────────────────────────────────────
  while IFS='|' read -r label source version; do
    [ -z "$label" ] && continue
    is_registry_source "$source" || continue
    if ! is_exact_pin "$version"; then
      FOUND=$((FOUND + 1))
      log "Unpinned module: ${REL} → ${label} (source: ${source}, current: \"${version:-<missing>}\")"

      LATEST=$(fetch_module_latest "$source" 2>/dev/null || echo "")
      if [ -n "$LATEST" ]; then
        echo ""
        echo "  Suggested fix for module '${label}' in ${REL}:"
        if [ -n "$version" ]; then
          printf '    sed -i '"'"'s|version = "%s"|version = "= %s"|g'"'"' "%s"\n' \
            "$version" "$LATEST" "$FILE"
        else
          echo "    # Add version = \"= ${LATEST}\" inside the ${label} module block"
        fi
        echo ""
      else
        warn "Could not fetch latest version for module ${source} — pin manually."
      fi
    fi
  done < <(
    awk '
      /^[[:space:]]*module[[:space:]]+"/ {
        match($0, /"([^"]+)"/, arr); label=arr[1]; in_module=1; depth=0
      }
      in_module {
        if (/\{/) depth++
        if (/\}/) { depth--; if (depth<=0) { in_module=0; label=""; src=""; ver="" } }
      }
      in_module && /source[[:space:]]*=/ {
        match($0, /"([^"]+)"/, arr); src=arr[1]
      }
      in_module && /version[[:space:]]*=/ {
        match($0, /"([^"]+)"/, arr); ver=arr[1]
      }
      in_module && /\}/ && depth==0 && label != "" && src != "" {
        print label "|" src "|" ver
      }
    ' "$FILE"
  )
done

if [ "$FOUND" -eq 0 ]; then
  log "✓ No unpinned sources found — nothing to suggest."
else
  echo ""
  log "${FOUND} unpinned source(s) found. Apply the suggestions above, then:"
  echo "  1. Run: node scripts/check-terraform-pinning.mjs"
  echo "  2. Commit the updated .tf files."
  echo "  3. See docs/TERRAFORM_VERSION_PINNING.md for the full bump workflow."
fi
