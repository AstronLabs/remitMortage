// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Static rollback-coverage check for Prisma migrations.
 *
 * Every migration must either ship a `down.sql` or be listed in
 * `prisma/rollback-manifest.json` with a reviewed runbook. Run from the
 * backend directory (or pass explicit paths):
 *
 *   npx tsx scripts/check-migration-rollbacks.ts
 *   npx tsx scripts/check-migration-rollbacks.ts \
 *     --migrations-dir prisma/migrations --manifest prisma/rollback-manifest.json
 */

import path from "path";
import { validateMigrationRollbacks } from "../src/services/migrationRollback.js";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

const migrationsDir = path.resolve(
  argValue("--migrations-dir") ?? path.join("prisma", "migrations")
);
const manifestPath = path.resolve(
  argValue("--manifest") ?? path.join("prisma", "rollback-manifest.json")
);

const report = validateMigrationRollbacks({ migrationsDir, manifestPath });

console.log(
  `Rollback coverage: ${report.verifiable.length} verifiable (down.sql), ` +
    `${report.irreversible.length} irreversible (runbook-backed)`
);

if (!report.ok) {
  for (const error of report.errors) {
    console.error(`✗ ${error}`);
  }
  process.exit(1);
}

console.log("✓ every migration declares a rollback path");
