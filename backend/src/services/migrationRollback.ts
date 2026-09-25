// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import fs from "fs";
import path from "path";

/**
 * Verifies that every Prisma migration declares how it can be rolled back.
 *
 * A migration is rollback-verifiable when its folder contains a `down.sql`; the
 * shell verifier then applies the down/up/down cycle against a scratch database
 * and diffs the schema. Migrations that genuinely cannot be reversed must be
 * listed in `rollback-manifest.json` with a reviewed runbook file. Anything
 * else fails the check.
 */

export interface RollbackManifestEntry {
  migration: string;
  runbook: string;
  reason?: string;
}

export interface RollbackManifest {
  irreversible: RollbackManifestEntry[];
}

export interface MigrationRollbackReport {
  ok: boolean;
  errors: string[];
  /** Migrations with a down.sql that the DB verifier will exercise. */
  verifiable: string[];
  /** Migrations allowed through on the strength of a reviewed runbook. */
  irreversible: string[];
}

export function loadRollbackManifest(manifestPath: string): RollbackManifest {
  const raw = fs.readFileSync(manifestPath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<RollbackManifest>;
  return { irreversible: parsed.irreversible ?? [] };
}

/** Returns the migration directory names (those containing `migration.sql`), sorted. */
export function listMigrations(migrationsDir: string): string[] {
  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) =>
      fs.existsSync(path.join(migrationsDir, name, "migration.sql"))
    )
    .sort();
}

export function validateMigrationRollbacks(opts: {
  migrationsDir: string;
  manifestPath: string;
}): MigrationRollbackReport {
  const errors: string[] = [];
  const verifiable: string[] = [];
  const irreversible: string[] = [];

  const migrations = listMigrations(opts.migrationsDir);
  const manifest = loadRollbackManifest(opts.manifestPath);
  const manifestDir = path.dirname(opts.manifestPath);
  const byName = new Map<string, RollbackManifestEntry>();

  for (const entry of manifest.irreversible) {
    if (byName.has(entry.migration)) {
      errors.push(`${entry.migration}: listed more than once in rollback-manifest.json`);
    }
    byName.set(entry.migration, entry);
  }

  for (const entry of manifest.irreversible) {
    if (!migrations.includes(entry.migration)) {
      errors.push(
        `rollback-manifest.json references unknown migration "${entry.migration}"`
      );
    }
  }

  for (const name of migrations) {
    const hasDown = fs.existsSync(
      path.join(opts.migrationsDir, name, "down.sql")
    );
    const entry = byName.get(name);

    if (hasDown && entry) {
      errors.push(
        `${name}: has a down.sql and is also listed as irreversible; choose one`
      );
      continue;
    }

    if (entry) {
      const runbookPath = path.resolve(manifestDir, entry.runbook);
      if (!fs.existsSync(runbookPath)) {
        errors.push(
          `${name}: irreversible but runbook not found at ${entry.runbook}`
        );
        continue;
      }
      irreversible.push(name);
      continue;
    }

    if (!hasDown) {
      errors.push(
        `${name}: no down.sql and not listed in rollback-manifest.json irreversibles`
      );
      continue;
    }

    verifiable.push(name);
  }

  return {
    ok: errors.length === 0,
    errors,
    verifiable,
    irreversible,
  };
}
