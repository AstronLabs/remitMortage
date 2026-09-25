#!/usr/bin/env node
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT
//
// check-terraform-pinning.mjs
//
// Scans all .tf files in the repository for module source blocks and
// required_providers blocks that lack an exact version pin.
//
// "Exact" means the version constraint resolves to a single version —
// i.e. it uses the "= X.Y.Z" operator (or just "X.Y.Z").
// Anything else (~>, >=, >, !=, range operators, or missing entirely)
// is flagged as unpinned.
//
// Exit codes
//   0 — all sources are exactly pinned
//   1 — one or more unpinned sources found (fails CI)

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// Directories to skip when walking the tree
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".terraform", "dist", "build",
  "coverage", ".next", "target",
]);

// Regex: match a required_providers block provider entry.
// Captures the provider label and the version string.
const REQUIRED_PROVIDERS_RE =
  /^\s*(\w[\w-]*)\s*=\s*\{[^}]*?version\s*=\s*"([^"]+)"/gms;

// Regex: match a module block source attribute.
// Captures the module label and source value.
const MODULE_SOURCE_RE =
  /^\s*module\s+"([\w-]+)"\s*\{[^}]*?source\s*=\s*"([^"]+)"[^}]*?(?:version\s*=\s*"([^"]+)")?[^}]*?\}/gms;

// A version is "exact" only when it is just a semver string or uses `= X.Y.Z`.
// Everything else (~>, >=, >, <=, <, !=, and any missing/empty value) is unpinned.
function isExactPin(version) {
  if (!version || version.trim() === "") return false;
  const v = version.trim();
  // Allow "= X.Y.Z" or bare "X.Y.Z" (no operators except optional leading =)
  return /^=?\s*\d+\.\d+\.\d+$/.test(v);
}

// Registry module sources MUST carry a `version` argument; git/local sources
// do not require one (they are pinned by ref or path). We identify registry
// sources as those NOT starting with "./", "../", or a protocol prefix.
function isRegistrySource(source) {
  return (
    !source.startsWith("./") &&
    !source.startsWith("../") &&
    !source.startsWith("git::") &&
    !source.startsWith("github.com") &&
    !source.startsWith("bitbucket.org") &&
    !source.startsWith("http://") &&
    !source.startsWith("https://")
  );
}

function walkTfFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) results.push(...walkTfFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".tf")) {
      results.push(full);
    }
  }
  return results;
}

function checkFile(filePath, repoRoot) {
  const rel = path.relative(repoRoot, filePath);
  const src = fs.readFileSync(filePath, "utf8");
  const violations = [];

  // ── Check required_providers ───────────────────────────────────────────
  for (const match of src.matchAll(REQUIRED_PROVIDERS_RE)) {
    const [, label, version] = match;
    if (!isExactPin(version)) {
      violations.push({
        file: rel,
        type: "provider",
        label,
        current: version,
        fix: `Change version = "${version}" to an exact pin, e.g. version = "= X.Y.Z"`,
      });
    }
  }

  // ── Check module blocks ────────────────────────────────────────────────
  for (const match of src.matchAll(MODULE_SOURCE_RE)) {
    const [, label, source, version] = match;
    if (!isRegistrySource(source)) continue; // local/git modules are exempt
    if (!isExactPin(version)) {
      violations.push({
        file: rel,
        type: "module",
        label,
        source,
        current: version ?? "<missing>",
        fix: version
          ? `Change version = "${version}" to an exact pin, e.g. version = "= X.Y.Z"`
          : `Add version = "= X.Y.Z" to module "${label}" (source: ${source})`,
      });
    }
  }

  return violations;
}

function main() {
  const repoRoot = process.argv[2]
    ? path.resolve(process.argv[2])
    : process.cwd();

  if (!fs.existsSync(repoRoot)) {
    console.error(`Directory not found: ${repoRoot}`);
    process.exit(1);
  }

  const tfFiles = walkTfFiles(repoRoot);

  if (tfFiles.length === 0) {
    console.log("No .tf files found — nothing to check.");
    process.exit(0);
  }

  const allViolations = [];
  for (const file of tfFiles) {
    allViolations.push(...checkFile(file, repoRoot));
  }

  if (allViolations.length === 0) {
    console.log(
      `✓ Terraform version pinning check passed — ${tfFiles.length} file(s) scanned, all sources exactly pinned.`
    );
    process.exit(0);
  }

  console.error(
    `✗ Terraform version pinning check FAILED — ${allViolations.length} unpinned source(s) found:\n`
  );

  for (const v of allViolations) {
    console.error(`  File   : ${v.file}`);
    console.error(`  Type   : ${v.type}`);
    console.error(`  Label  : ${v.label}${v.source ? ` (source: ${v.source})` : ""}`);
    console.error(`  Current: ${v.current}`);
    console.error(`  Fix    : ${v.fix}`);
    console.error("");
  }

  console.error(
    "Policy: every provider and registry module source must use an exact version pin\n" +
    '(e.g. version = "= 5.31.0"). Floating constraints (~>, >=, >) are not allowed.\n' +
    "See docs/TERRAFORM_VERSION_PINNING.md for the full policy and how to bump a pin."
  );

  process.exit(1);
}

main();
