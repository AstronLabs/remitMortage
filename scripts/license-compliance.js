#!/usr/bin/env node
/**
 * Dependency license compliance checker.
 *
 * Reads a dependency license report (npm `license-checker --json` or Rust
 * `cargo-license --json`) and an allowlist of SPDX license IDs, and exits 1
 * with a clear report if any dependency declares a license that is not in the
 * allowlist. Extending the allowlist is a data-only change (edit
 * scripts/license-allowlist.json) — no workflow/script changes required.
 *
 * A single package can be excepted without allowing its license everywhere by
 * adding `"name": "reason"` to scripts/license-exceptions.json (next to the
 * allowlist); a `name@version` key pins the exception to that version.
 *
 * Usage:
 *   node scripts/license-compliance.js <npm|cargo> <report.json> <allowlist.json>
 */
"use strict";

const fs = require("fs");
const path = require("path");

const [format, reportPath, allowlistPath] = process.argv.slice(2);
if (!format || !reportPath || !allowlistPath) {
  console.error("usage: node scripts/license-compliance.js <npm|cargo> <report.json> <allowlist.json>");
  process.exit(2);
}

const allow = new Set(JSON.parse(fs.readFileSync(allowlistPath, "utf8")).map((s) => String(s).trim()));
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));

const exceptionsPath = path.join(path.dirname(allowlistPath), "license-exceptions.json");
const exceptions = fs.existsSync(exceptionsPath) ? JSON.parse(fs.readFileSync(exceptionsPath, "utf8")) : {};

/** True when the package (`name@version`) has a documented exception. */
function excepted(pkg) {
  const name = pkg.slice(0, pkg.lastIndexOf("@"));
  return Object.hasOwn(exceptions, pkg) || Object.hasOwn(exceptions, name);
}

/** True when every declared license for an entry is in the allowlist. */
function allowed(licenses) {
  const list = Array.isArray(licenses) ? licenses : [licenses];
  return list.length > 0 && list.every((l) => allow.has(String(l).trim()));
}

const violations = [];
if (format === "npm") {
  for (const [pkg, meta] of Object.entries(report)) {
    // Dependencies that only carry a license file (no SPDX id) are skipped:
    // there is no machine-readable license to compare.
    if (!meta.licenses) continue;
    if (!allowed(meta.licenses) && !excepted(pkg)) violations.push({ pkg, licenses: meta.licenses });
  }
} else if (format === "cargo") {
  for (const dep of report) {
    if (!allowed(dep.license) && !excepted(`${dep.name}@${dep.version}`)) violations.push({ pkg: `${dep.name}@${dep.version}`, licenses: dep.license });
  }
} else {
  console.error(`unknown report format: ${format}`);
  process.exit(2);
}

if (violations.length > 0) {
  console.error("License compliance FAILED: the following dependencies declare a license not in the allowlist:");
  for (const v of violations) {
    console.error(`  - ${v.pkg}: ${JSON.stringify(v.licenses)}`);
  }
  console.error(`Allowlist: ${allowlistPath} (add a license id here to allow it)`);
  process.exit(1);
}

const count = format === "npm" ? Object.keys(report).length : report.length;
console.log(`License compliance OK: ${count} dependencies checked, all licenses allowed.`);
