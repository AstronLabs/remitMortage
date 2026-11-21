// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";

const migrationDir = path.resolve(
  __dirname,
  "../../prisma/migrations/20261016000000_live_loan_application_indexes"
);

describe("live loan-application indexes", () => {
  const migration = fs.readFileSync(path.join(migrationDir, "migration.sql"), "utf8");
  const rollback = fs.readFileSync(path.join(migrationDir, "down.sql"), "utf8");
  const guide = fs.readFileSync(path.join(migrationDir, "README.md"), "utf8");

  it("creates concurrent partial indexes for the two live-row query paths", () => {
    expect(migration).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS "LoanApplication_live_status_idx"/);
    expect(migration).toMatch(/ON "LoanApplication" \("status"\)\s+WHERE "deletedAt" IS NULL/);
    expect(migration).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS "LoanApplication_live_applicantId_createdAt_idx"/);
    expect(migration).toMatch(/ON "LoanApplication" \("applicantId", "createdAt"\)\s+WHERE "deletedAt" IS NULL/);
  });

  it("documents EXPLAIN guidance and provides concurrent rollback", () => {
    expect(guide).toContain("EXPLAIN (ANALYZE, BUFFERS)");
    expect(guide).toContain('"status" = \'Pending\' AND "deletedAt" IS NULL');
    expect(guide).toContain('"applicantId" = \'representative-applicant-id\'');
    expect(rollback).toContain("DROP INDEX CONCURRENTLY");
    expect(rollback).toContain("LoanApplication_live_status_idx");
    expect(rollback).toContain("LoanApplication_live_applicantId_createdAt_idx");
  });
});
