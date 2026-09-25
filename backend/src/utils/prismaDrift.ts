// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Result of a drift check between two Prisma schemas.
 */
export interface PrismaDriftResult {
  /** True when no diff was found (schemas in sync). */
  inSync: boolean;
  /** True when drift was detected (schemas differ). */
  hasDrift: boolean;
  /** Process exit code from `prisma migrate diff --exit-code` (0=clean, 2=drift, 1=error). */
  exitCode: number;
  /** Human-readable diff summary (stdout from prisma). */
  humanReadable: string;
  /** SQL script to migrate FROM -> TO (only populated when hasDrift). */
  sqlScript: string;
  /** Absolute paths used for the diff. */
  from: string;
  to: string;
}

export interface DriftCheckOptions {
  /** Snapshot schema file (FROM). Defaults to prisma/__snapshots__/production-schema.prisma */
  fromSchema?: string;
  /** Committed schema file (TO). Defaults to prisma/schema.prisma */
  toSchema?: string;
  /** Working directory where prisma.config.ts lives. Defaults to backend/ */
  cwd?: string;
  /** Path to prisma binary (default: npx prisma) */
  prismaBin?: string;
}

/**
 * Run `prisma migrate diff` between two schema files.
 *
 * This is the programmatic equivalent of `backend/scripts/detect-prisma-drift.sh`
 * file-to-file mode, intended for integration tests and local verification.
 *
 * Uses `--exit-code` so callers can distinguish clean (0) vs drift (2) vs error (1).
 *
 * @example
 * const result = detectPrismaDrift();
 * if (result.hasDrift) console.log(result.humanReadable);
 */
export function detectPrismaDrift(options: DriftCheckOptions = {}): PrismaDriftResult {
  const cwd = options.cwd ?? process.cwd();
  // Resolve default paths relative to cwd if not absolute
  const defaultFrom = path.resolve(cwd, "prisma/__snapshots__/production-schema.prisma");
  const defaultTo = path.resolve(cwd, "prisma/schema.prisma");

  const fromSchema = options.fromSchema ? path.resolve(cwd, options.fromSchema) : defaultFrom;
  const toSchema = options.toSchema ? path.resolve(cwd, options.toSchema) : defaultTo;
  const prismaBin = options.prismaBin ?? "npx prisma";

  if (!fs.existsSync(fromSchema)) {
    throw new Error(`Snapshot schema not found: ${fromSchema}. Run backend/scripts/sync-production-schema.sh to generate it.`);
  }
  if (!fs.existsSync(toSchema)) {
    throw new Error(`Target schema not found: ${toSchema}`);
  }

  const runDiff = (useScript: boolean): { output: string; exitCode: number } => {
    const scriptFlag = useScript ? " --script" : "";
    const cmd = `${prismaBin} migrate diff --from-schema="${fromSchema}" --to-schema="${toSchema}"${scriptFlag} --exit-code`;
    try {
      const output = execSync(cmd, {
        cwd,
        encoding: "utf-8",
        stdio: "pipe",
        env: { ...process.env },
      });
      return { output: output.toString(), exitCode: 0 };
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
      const stdout = e.stdout?.toString() ?? "";
      const stderr = e.stderr?.toString() ?? "";
      const combined = stdout + stderr || e.message || "";
      // Prisma uses exit 2 for drift, 1 for error
      const exitCode = typeof e.status === "number" ? e.status : 1;
      return { output: combined, exitCode };
    }
  };

  const human = runDiff(false);

  let sqlScript = "";
  if (human.exitCode === 2) {
    const sql = runDiff(true);
    sqlScript = sql.output;
  }

  const inSync = human.exitCode === 0;
  const hasDrift = human.exitCode === 2;

  // If exit code is 1, surface as error but still return result
  if (human.exitCode === 1) {
    // Include prisma's error in humanReadable for callers to display
  }

  return {
    inSync,
    hasDrift,
    exitCode: human.exitCode,
    humanReadable: human.output,
    sqlScript,
    from: fromSchema,
    to: toSchema,
  };
}

/**
 * Helper to create a temporary drifted schema for testing.
 * Copies `fromSchema` to a temp file and appends `extraPrisma` content.
 * Caller must clean up the temp file.
 */
export function createTempDriftedSchema(fromSchema: string, extraPrisma: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prisma-drift-"));
  const tmpSchema = path.join(tmpDir, "schema.prisma");
  const content = fs.readFileSync(fromSchema, "utf-8");
  fs.writeFileSync(tmpSchema, content + "\n" + extraPrisma, "utf-8");
  return tmpSchema;
}

/**
 * Validate that a Prisma schema file parses cleanly.
 * Useful to ensure test fixtures are not accidentally broken.
 */
export function validateSchema(schemaPath: string, cwd?: string): boolean {
  const workdir = cwd ?? process.cwd();
  const absPath = path.resolve(workdir, schemaPath);
  try {
    execSync(`npx prisma validate --schema="${absPath}"`, {
      cwd: workdir,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}
