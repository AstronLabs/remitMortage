// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import fs from "fs";
import os from "os";
import path from "path";
import {
  listMigrations,
  validateMigrationRollbacks,
} from "../services/migrationRollback";

const BACKEND_DIR = path.resolve(__dirname, "..", "..");
const REAL_MIGRATIONS = path.join(BACKEND_DIR, "prisma", "migrations");
const REAL_MANIFEST = path.join(BACKEND_DIR, "prisma", "rollback-manifest.json");

interface ManifestEntry {
  migration: string;
  runbook: string;
}

function makeFixture(): { root: string; migrationsDir: string; manifestPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rollback-fixture-"));
  const migrationsDir = path.join(root, "migrations");
  fs.mkdirSync(migrationsDir, { recursive: true });
  return { root, migrationsDir, manifestPath: path.join(root, "rollback-manifest.json") };
}

function addMigration(
  migrationsDir: string,
  name: string,
  opts: { down?: boolean; up?: boolean } = {}
): void {
  const dir = path.join(migrationsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  if (opts.up !== false) {
    fs.writeFileSync(path.join(dir, "migration.sql"), "-- up\n");
  }
  if (opts.down) {
    fs.writeFileSync(path.join(dir, "down.sql"), "-- down\n");
  }
}

function writeManifest(manifestPath: string, entries: ManifestEntry[]): void {
  fs.writeFileSync(manifestPath, JSON.stringify({ irreversible: entries }));
}

function run(root: string, migrationsDir: string, manifestPath: string) {
  return validateMigrationRollbacks({ migrationsDir, manifestPath });
}

describe("validateMigrationRollbacks", () => {
  it("passes for the real repository migration set", () => {
    const report = validateMigrationRollbacks({
      migrationsDir: REAL_MIGRATIONS,
      manifestPath: REAL_MANIFEST,
    });

    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.verifiable).toContain(
      "20260829160000_add_referral_attribution"
    );
    expect(report.irreversible).toContain(
      "20260828000000_add_draft_stale_cleanup_fields"
    );
    // Coverage is complete: nothing is silently skipped.
    expect(report.verifiable.length + report.irreversible.length).toBe(
      listMigrations(REAL_MIGRATIONS).length
    );
  });

  it("fails when a migration has neither down.sql nor a runbook entry", () => {
    const { root, migrationsDir, manifestPath } = makeFixture();
    addMigration(migrationsDir, "20260101_missing");
    writeManifest(manifestPath, []);

    const report = run(root, migrationsDir, manifestPath);

    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toMatch(/no down\.sql/);
  });

  it("fails when an irreversible entry's runbook is missing", () => {
    const { root, migrationsDir, manifestPath } = makeFixture();
    addMigration(migrationsDir, "20260101_irreversible");
    writeManifest(manifestPath, [
      { migration: "20260101_irreversible", runbook: "rollback-runbooks/nope.md" },
    ]);

    const report = run(root, migrationsDir, manifestPath);

    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toMatch(/runbook not found/);
  });

  it("accepts an irreversible migration with a reviewed runbook", () => {
    const { root, migrationsDir, manifestPath } = makeFixture();
    addMigration(migrationsDir, "20260101_irreversible");
    fs.mkdirSync(path.join(root, "rollback-runbooks"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "rollback-runbooks", "rb.md"),
      "# rollback runbook\n"
    );
    writeManifest(manifestPath, [
      { migration: "20260101_irreversible", runbook: "rollback-runbooks/rb.md" },
    ]);

    const report = run(root, migrationsDir, manifestPath);

    expect(report.ok).toBe(true);
    expect(report.irreversible).toEqual(["20260101_irreversible"]);
    expect(report.verifiable).toEqual([]);
  });

  it("rejects a migration that has both a down.sql and an irreversible entry", () => {
    const { root, migrationsDir, manifestPath } = makeFixture();
    addMigration(migrationsDir, "20260101_ambiguous", { down: true });
    writeManifest(manifestPath, [
      { migration: "20260101_ambiguous", runbook: "rollback-runbooks/rb.md" },
    ]);

    const report = run(root, migrationsDir, manifestPath);

    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toMatch(/choose one/);
  });

  it("rejects a manifest entry for a migration that does not exist", () => {
    const { root, migrationsDir, manifestPath } = makeFixture();
    addMigration(migrationsDir, "20260101_real", { down: true });
    writeManifest(manifestPath, [
      { migration: "20260101_ghost", runbook: "rollback-runbooks/rb.md" },
    ]);

    const report = run(root, migrationsDir, manifestPath);

    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toMatch(/unknown migration/);
  });

  it("sorts migrations and ignores directories without migration.sql", () => {
    const { migrationsDir } = makeFixture();
    addMigration(migrationsDir, "20260103_c", { down: true });
    addMigration(migrationsDir, "20260101_a", { down: true });
    fs.mkdirSync(path.join(migrationsDir, "not_a_migration"));

    expect(listMigrations(migrationsDir)).toEqual([
      "20260101_a",
      "20260103_c",
    ]);
  });
});
