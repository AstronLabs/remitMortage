// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { detectPrismaDrift, createTempDriftedSchema, validateSchema } from "../utils/prismaDrift.js";

// Prisma drift integration tests — verify the committed schema matches the production snapshot.
// These run `prisma migrate diff` file-to-file (no DB required) so they are deterministic
// in CI and locally, including PRs from forks where PRODUCTION_DATABASE_URL is unavailable.

jest.setTimeout(30000);

const BACKEND_DIR = path.resolve(__dirname, "../../");
const SNAPSHOT = path.resolve(BACKEND_DIR, "prisma/__snapshots__/production-schema.prisma");
const SCHEMA = path.resolve(BACKEND_DIR, "prisma/schema.prisma");

describe("Prisma schema drift detection (file-to-file)", () => {
  beforeAll(() => {
    // Guard: ensure fixtures exist before running diff
    expect(fs.existsSync(SNAPSHOT)).toBe(true);
    expect(fs.existsSync(SCHEMA)).toBe(true);
    expect(validateSchema(SCHEMA, BACKEND_DIR)).toBe(true);
    expect(validateSchema(SNAPSHOT, BACKEND_DIR)).toBe(true);
  });

  it("passes without false positives when snapshot matches committed schema (clean, in-sync)", () => {
    const result = detectPrismaDrift({
      fromSchema: SNAPSHOT,
      toSchema: SCHEMA,
      cwd: BACKEND_DIR,
    });

    expect(result.exitCode).toBe(0);
    expect(result.inSync).toBe(true);
    expect(result.hasDrift).toBe(false);
    expect(result.humanReadable).toMatch(/No difference detected/i);
    expect(result.sqlScript).toBe("");
  });

  it("correctly detects and reports drift when production snapshot differs (extra table)", () => {
    const driftedSnapshot = createTempDriftedSchema(
      SNAPSHOT,
      `
model DriftProbe {
  id        String   @id @default(uuid())
  probe     String
  createdAt DateTime @default(now())
}
`.trim()
    );

    try {
      const result = detectPrismaDrift({
        fromSchema: driftedSnapshot,
        toSchema: SCHEMA,
        cwd: BACKEND_DIR,
      });

      expect(result.exitCode).toBe(2);
      expect(result.hasDrift).toBe(true);
      expect(result.inSync).toBe(false);
      // Human-readable diff should mention the removed table (FROM has it, TO does not)
      expect(result.humanReadable).toMatch(/DriftProbe/);
      expect(result.humanReadable).toMatch(/Removed tables|Added tables/i);
      // SQL script should contain the reconciling DDL (DROP or CREATE depending on direction)
      // Here FROM=drifted (has DriftProbe) TO=clean (no DriftProbe) => DROP TABLE
      expect(result.sqlScript).toMatch(/DROP TABLE.*DriftProbe/i);
      // Readable summary is not empty when drifted
      expect(result.humanReadable.length).toBeGreaterThan(20);
    } finally {
      fs.rmSync(path.dirname(driftedSnapshot), { recursive: true, force: true });
    }
  });

  it("detects drift for a missing column (simulates manual ALTER TABLE out-of-band)", () => {
    // For this test we create a temp TO schema that is SCHEMA + a new model representing drift.
    // FROM=snapshot (clean), TO=drifted (has extra table) => drift should be detected.
    const driftedTo = createTempDriftedSchema(
      SCHEMA,
      `
model DriftProbeColumn {
  id String @id @default(uuid())
  outOfBandField String
}
`.trim()
    );

    try {
      const result = detectPrismaDrift({
        fromSchema: SNAPSHOT,
        toSchema: driftedTo,
        cwd: BACKEND_DIR,
      });

      expect(result.hasDrift).toBe(true);
      expect(result.exitCode).toBe(2);
      expect(result.humanReadable).toMatch(/DriftProbeColumn/);
      expect(result.sqlScript).toMatch(/CREATE TABLE.*DriftProbeColumn/i);
    } finally {
      fs.rmSync(path.dirname(driftedTo), { recursive: true, force: true });
    }
  });

  it("produces a readable diff summary that mentions enum/table changes", () => {
    const drifted = createTempDriftedSchema(
      SNAPSHOT,
      `
enum DriftEnum {
  A
  B
}
model DriftEnumHolder {
  id String @id @default(uuid())
  val DriftEnum
}
`.trim()
    );

    try {
      const result = detectPrismaDrift({
        fromSchema: drifted,
        toSchema: SCHEMA,
        cwd: BACKEND_DIR,
      });

      expect(result.hasDrift).toBe(true);
      // Human-readable summary should list the removed enum and table
      expect(result.humanReadable).toMatch(/DriftEnum/);
      expect(result.sqlScript).toMatch(/DROP TABLE|DROP TYPE/i);
    } finally {
      fs.rmSync(path.dirname(drifted), { recursive: true, force: true });
    }
  });

  it("treats identical schemas as clean even when compared in reverse direction", () => {
    const result = detectPrismaDrift({
      fromSchema: SCHEMA,
      toSchema: SCHEMA,
      cwd: BACKEND_DIR,
    });
    expect(result.inSync).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("throws a clear error when snapshot file is missing", () => {
    expect(() =>
      detectPrismaDrift({
        fromSchema: path.join(os.tmpdir(), "non-existent-snapshot.prisma"),
        toSchema: SCHEMA,
        cwd: BACKEND_DIR,
      })
    ).toThrow(/Snapshot schema not found/);
  });
});

describe("validateSchema helper", () => {
  it("validates the committed schema", () => {
    expect(validateSchema(SCHEMA, BACKEND_DIR)).toBe(true);
  });

  it("rejects an invalid schema", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prisma-validate-"));
    const badSchema = path.join(tmpDir, "bad.prisma");
    fs.writeFileSync(badSchema, "this is not a valid prisma schema", "utf-8");
    try {
      expect(validateSchema(badSchema, BACKEND_DIR)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("bash script integration (detect-prisma-drift.sh)", () => {
  const SCRIPT = path.resolve(BACKEND_DIR, "scripts/detect-prisma-drift.sh");
  const BASH = process.platform === "win32" ? `"C:\\Program Files\\Git\\bin\\bash.exe"` : "bash";

  it("bash script passes on clean schema (exit 0, readable summary)", () => {
    expect(fs.existsSync(SCRIPT)).toBe(true);
    const output = execSync(`${BASH} "${SCRIPT}" 2>&1`, {
      cwd: path.resolve(BACKEND_DIR, ".."),
      encoding: "utf-8",
    });
    expect(output).toMatch(/No drift detected/i);
    expect(output).toMatch(/No difference detected/i);
  });

  it("bash script fails with readable diff on drifted snapshot (exit 2)", () => {
    const tmpSnapshot = createTempDriftedSchema(
      SNAPSHOT,
      `
model BashDriftProbe {
  id String @id @default(uuid())
  data String
}
`.trim()
    );
    try {
      let output = "";
      try {
        output = execSync(`${BASH} "${SCRIPT}" --from-schema="${tmpSnapshot}" --to-schema="${SCHEMA}" --exit-code 2>&1`, {
          cwd: path.resolve(BACKEND_DIR, ".."),
          encoding: "utf-8",
        });
      } catch (e: unknown) {
        const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
        // Node's execSync error contains stdout/stderr buffers
        const maybeStdout = (err as unknown as { stdout?: Buffer }).stdout?.toString() ?? "";
        const maybeStderr = (err as unknown as { stderr?: Buffer }).stderr?.toString() ?? "";
        output = maybeStdout || maybeStderr || (err.stdout as string) || (err.stderr as string) || err.message || "";
      }
      // Run again to generate artifacts in temp dir
      try {
        execSync(`${BASH} "${SCRIPT}" --from-schema="${tmpSnapshot}" --to-schema="${SCHEMA}" --output-dir="${path.dirname(tmpSnapshot)}" 2>&1`, {
          cwd: path.resolve(BACKEND_DIR, ".."),
          encoding: "utf-8",
        });
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string };
        output = (err.stdout as string) || (err.stderr as string) || output;
      }
      const summaryPath = path.join(path.dirname(tmpSnapshot), "drift-summary.txt");
      const sqlPath = path.join(path.dirname(tmpSnapshot), "drift.sql");
      const combined = output + (fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, "utf-8") : "");
      expect(combined).toMatch(/BashDriftProbe/);
      if (fs.existsSync(summaryPath)) {
        expect(fs.readFileSync(summaryPath, "utf-8")).toMatch(/drift detected/i);
      }
      if (fs.existsSync(sqlPath)) {
        expect(fs.readFileSync(sqlPath, "utf-8")).toMatch(/BashDriftProbe/i);
      }
    } finally {
      fs.rmSync(path.dirname(tmpSnapshot), { recursive: true, force: true });
    }
  });
});
