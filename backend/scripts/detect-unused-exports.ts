// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Reports exported symbols that nothing else in the backend imports.
 *
 * Run from the backend directory (or pass explicit paths):
 *
 *   npx tsx scripts/detect-unused-exports.ts
 *   npx tsx scripts/detect-unused-exports.ts --root . --config unused-exports.config.json
 *   npx tsx scripts/detect-unused-exports.ts --json
 *
 * Route modules and barrels/index files are treated as an intentional public
 * surface and never reported; add `publicGlobs`/`allowlist` entries to
 * `unused-exports.config.json` for anything else. See
 * `docs/UNUSED_EXPORT_DETECTION.md`.
 *
 * By default the report is non-blocking (exit 0) — it lists findings without
 * failing the build. Pass --fail-on-unused to exit 1 when new dead exports are
 * found (e.g. when gating locally or once CI enforces the check).
 */

import path from "path";
import {
  DEFAULT_PUBLIC_GLOBS,
  loadSourceFiles,
  loadUnusedExportConfig,
  scanUnusedExports,
} from "../src/services/unusedExportScan.js";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

const rootDir = path.resolve(argValue("--root") ?? ".");
const configPath = path.resolve(
  argValue("--config") ?? path.join(rootDir, "unused-exports.config.json")
);
const asJson = process.argv.includes("--json");
const failOnUnused = process.argv.includes("--fail-on-unused");

const configFile = loadUnusedExportConfig(configPath);
const config = {
  publicGlobs: [...DEFAULT_PUBLIC_GLOBS, ...(configFile.publicGlobs ?? [])],
  allowlist: configFile.allowlist ?? [],
};

const files = loadSourceFiles(rootDir, config);
const report = scanUnusedExports(files, config);

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `Scanned ${report.scannedFiles} files, ${report.exportedSymbols} exports: ` +
      `${report.unusedExports.length} unused, ${report.suppressed.length} suppressed (public surface / allowlisted)`
  );
  for (const entry of report.unusedExports) {
    console.log(`  ! ${entry.file}:${entry.line} — ${entry.name} has no importer`);
  }
  if (report.unusedExports.length === 0) {
    console.log("✓ no unused exports found");
  }
}

if (failOnUnused && report.unusedExports.length > 0) {
  process.exit(1);
}
