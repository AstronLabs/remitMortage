// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Unsafe-migration lint gate (issue #1035).
 *
 * Fails when a new Prisma migration performs an operation that can fail or
 * stall production. The documented list of patterns is
 * `UNSAFE_PATTERNS` in `src/services/migrationSafety.ts`; run this script with
 * `--list-patterns` to print it.
 *
 * A migration that genuinely needs one of these operations declares a reviewed
 * waiver with a reason, next to the statement:
 *
 *     -- migration-ok: <why this is safe>
 *
 * Usage:
 *   npx tsx scripts/migration-safety-gate.ts                 # new migrations only
 *   npx tsx scripts/migration-safety-gate.ts --all           # every migration
 *   npx tsx scripts/migration-safety-gate.ts --since <stamp> # migrations after <stamp>
 *   npx tsx scripts/migration-safety-gate.ts --json          # machine-readable
 *   npx tsx scripts/migration-safety-gate.ts --list-patterns
 *
 * Exit codes: 0 = clean, 1 = at least one unwaived unsafe operation.
 */

import path from "path";

import { UNSAFE_PATTERNS, validateMigrationSafety } from "../src/services/migrationSafety.js";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

const argv = process.argv.slice(2);

if (argv.includes("--list-patterns")) {
  for (const pattern of UNSAFE_PATTERNS) {
    console.log(`${pattern.id}\n  ${pattern.summary}\n  fix: ${pattern.hint}\n`);
  }
  process.exit(0);
}

const migrationsDir = path.resolve(argValue("--migrations-dir") ?? path.join("prisma", "migrations"));
const report = validateMigrationSafety({
  migrationsDir,
  since: argValue("--since"),
  all: argv.includes("--all"),
});

if (argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

if (report.ok) {
  console.log(
    `[migration-safety] OK — ${report.checked.length} new migration(s) checked, ` +
      `${report.grandfathered.length} grandfathered.`
  );
  process.exit(0);
}

console.error(`[migration-safety] ${report.findings.length} unsafe operation(s) found:\n`);
for (const finding of report.findings) {
  const file = `${migrationsDir}/${finding.migration}/migration.sql`;
  console.error(`  ${finding.migration}/migration.sql:${finding.line}  [${finding.pattern}]`);
  console.error(`    ${finding.statement}`);
  console.error(`    → ${finding.hint}\n`);
  // GitHub annotation so the finding shows up inline on the pull request.
  console.error(`::error file=${file},line=${finding.line}::[${finding.pattern}] ${finding.hint}`);
}
console.error("Fix the migration, or waive it with `-- migration-ok: <reason>`.");
process.exit(1);
