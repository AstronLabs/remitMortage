// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Tests for the unsafe-migration lint (issue #1035).
 *
 * Every documented pattern gets a case that must be caught, a set of safe
 * variants that must pass, the waiver behaviour, and an end-to-end pass over a
 * scratch migrations directory.
 */

import fs from "fs";
import os from "os";
import path from "path";

import {
  LINT_INTRODUCED_AFTER,
  UNSAFE_PATTERNS,
  isGrandfathered,
  scanMigrationSql,
  validateMigrationSafety,
} from "../services/migrationSafety.js";

const REPO_MIGRATIONS = path.resolve(__dirname, "../../prisma/migrations");

function patterns(sql: string): string[] {
  return scanMigrationSql(sql).map((finding) => finding.pattern);
}

function writeMigration(root: string, name: string, sql: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "migration.sql"), sql);
}

describe("unsafe operation detection", () => {
  const cases: Array<{ pattern: string; sql: string }> = [
    {
      pattern: "add-not-null-column-without-default",
      sql: `ALTER TABLE "Loan" ADD COLUMN "score" INTEGER NOT NULL;`,
    },
    { pattern: "set-not-null", sql: `ALTER TABLE "Loan" ALTER COLUMN "score" SET NOT NULL;` },
    { pattern: "alter-column-type", sql: `ALTER TABLE "Loan" ALTER COLUMN "amount" TYPE BIGINT;` },
    {
      pattern: "add-foreign-key-without-not-valid",
      sql: `ALTER TABLE "Loan" ADD CONSTRAINT "Loan_ref_fkey" FOREIGN KEY ("refId") REFERENCES "Ref"("id");`,
    },
    {
      pattern: "add-check-constraint-without-not-valid",
      sql: `ALTER TABLE "Loan" ADD CONSTRAINT "Loan_amount_check" CHECK ("amount" > 0);`,
    },
    {
      pattern: "add-unique-constraint",
      sql: `ALTER TABLE "Loan" ADD CONSTRAINT "Loan_ref_key" UNIQUE ("ref");`,
    },
    { pattern: "create-index-without-concurrently", sql: `CREATE INDEX "Loan_amount_idx" ON "Loan"("amount");` },
    { pattern: "drop-column", sql: `ALTER TABLE "Loan" DROP COLUMN "legacy";` },
    { pattern: "drop-table", sql: `DROP TABLE "Loan";` },
    { pattern: "rename-column-or-table", sql: `ALTER TABLE "Loan" RENAME COLUMN "old" TO "new";` },
  ];

  it("has a unit case for every documented pattern", () => {
    expect(new Set(cases.map((testCase) => testCase.pattern))).toEqual(
      new Set(UNSAFE_PATTERNS.map((pattern) => pattern.id))
    );
  });

  it.each(cases)("flags $pattern", ({ pattern, sql }) => {
    expect(patterns(sql)).toContain(pattern);
  });
});

describe("safe variants are not flagged", () => {
  it("accepts a NOT NULL column that carries a default", () => {
    expect(patterns(`ALTER TABLE "Loan" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;`)).toEqual([]);
  });

  it("accepts a concurrent index build", () => {
    expect(patterns(`CREATE INDEX CONCURRENTLY "Loan_amount_idx" ON "Loan"("amount");`)).toEqual([]);
  });

  it("accepts NOT VALID foreign keys and check constraints", () => {
    expect(
      patterns(
        `ALTER TABLE "Loan" ADD CONSTRAINT "Loan_ref_fkey" FOREIGN KEY ("refId") REFERENCES "Ref"("id") NOT VALID;`
      )
    ).toEqual([]);
    expect(
      patterns(`ALTER TABLE "Loan" ADD CONSTRAINT "Loan_amount_check" CHECK ("amount" > 0) NOT VALID;`)
    ).toEqual([]);
  });

  it("accepts a nullable column and dropping NOT NULL", () => {
    expect(patterns(`ALTER TABLE "Loan" ADD COLUMN "note" TEXT;`)).toEqual([]);
    expect(patterns(`ALTER TABLE "Loan" ALTER COLUMN "note" DROP NOT NULL;`)).toEqual([]);
  });

  it("ignores keywords inside comments and string literals", () => {
    expect(patterns(`-- DROP TABLE "Loan" is never right\nSELECT 'DROP COLUMN "x"';`)).toEqual([]);
  });
});

describe("waivers and line numbers", () => {
  it("reports the line of the offending statement", () => {
    const sql = `-- add a column\nALTER TABLE "Loan" ADD COLUMN "note" TEXT;\n\nALTER TABLE "Loan" DROP COLUMN "legacy";\n`;

    const findings = scanMigrationSql(sql);

    expect(findings).toHaveLength(1);
    expect(findings[0].pattern).toBe("drop-column");
    expect(findings[0].line).toBe(4);
  });

  it("honours a waiver on the line above the statement", () => {
    const sql = `-- migration-ok: the column was backfilled in the previous release\nALTER TABLE "Loan" DROP COLUMN "legacy";\n`;

    expect(patterns(sql)).toEqual([]);
  });

  it("honours a waiver trailing the statement", () => {
    expect(patterns(`ALTER TABLE "Loan" DROP COLUMN "legacy"; -- migration-ok: unused since v2\n`)).toEqual([]);
  });

  it("does not honour a waiver without a reason", () => {
    const sql = `-- migration-ok:\nALTER TABLE "Loan" DROP COLUMN "legacy";\n`;

    expect(patterns(sql)).toEqual(["drop-column"]);
  });

  it("only waives the statement it is next to", () => {
    const sql = [
      `-- migration-ok: reviewed`,
      `ALTER TABLE "Loan" DROP COLUMN "legacy";`,
      `DROP TABLE "LoanArchive";`,
      ``,
    ].join("\n");

    expect(patterns(sql)).toEqual(["drop-table"]);
  });
});

describe("validateMigrationSafety", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "migration-safety-"));
    writeMigration(root, "20260101000000_legacy_drop", `ALTER TABLE "Loan" DROP COLUMN "old";`);
    writeMigration(root, "20261101000000_add_flag", `ALTER TABLE "Loan" ADD COLUMN "flag" TEXT NOT NULL;`);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("grandfathers migrations at or before the cut-off", () => {
    expect(isGrandfathered(`${LINT_INTRODUCED_AFTER}_old`)).toBe(true);
    expect(isGrandfathered(LINT_INTRODUCED_AFTER)).toBe(true);
    expect(isGrandfathered("20990101000000_new")).toBe(false);
  });

  it("fails a new migration with an unsafe operation and passes it once waived", () => {
    const failing = validateMigrationSafety({ migrationsDir: root, since: "20260601000000" });

    expect(failing.ok).toBe(false);
    expect(failing.checked).toEqual(["20261101000000_add_flag"]);
    expect(failing.grandfathered).toEqual(["20260101000000_legacy_drop"]);
    expect(failing.findings.map((finding) => finding.migration)).toEqual(["20261101000000_add_flag"]);

    writeMigration(
      root,
      "20261101000000_add_flag",
      `-- migration-ok: the table is empty at deploy time\nALTER TABLE "Loan" ADD COLUMN "flag" TEXT NOT NULL;`
    );

    const passing = validateMigrationSafety({ migrationsDir: root, since: "20260601000000" });

    expect(passing.ok).toBe(true);
    expect(passing.findings).toEqual([]);
  });

  it("checks grandfathered migrations too when asked", () => {
    const report = validateMigrationSafety({ migrationsDir: root, all: true });

    expect(report.checked).toContain("20260101000000_legacy_drop");
    expect(report.grandfathered).toEqual([]);
  });
});

describe("the repository", () => {
  it("has no unsafe operation in a migration added after the lint was introduced", () => {
    const report = validateMigrationSafety({ migrationsDir: REPO_MIGRATIONS });

    expect(report.findings).toEqual([]);
  });
});
