// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { execSync } from "child_process";
import logger from "./logger.js";

export interface PrismaCheckResult {
  ok: boolean;
  pending: number;
  applied: number;
  message: string;
}

/**
 * Run `npx prisma migrate status` and parse the result.
 *
 * The CLI outputs lines like:
 *   "1 migration found, 0 pending"
 *   "2 migrations found, 1 pending"
 *
 * Returns structured result with counts and human-readable message.
 */
export function checkPrismaMigrations(): PrismaCheckResult {
  let stdout: string;
  try {
    stdout = execSync("npx prisma migrate status", {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env },
    });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr || "";
    const stdoutErr = (err as { stdout?: string }).stdout || "";
    const output = stdoutErr || stderr || (err as Error).message;

    const pendingMatch = output.match(/(\d+)\s+pending/i);
    if (pendingMatch) {
      const pending = parseInt(pendingMatch[1], 10);
      return {
        ok: false,
        pending,
        applied: 0,
        message: `Schema is out of sync: ${pending} pending migration(s). Run "npm run db:migrate" or "npx prisma migrate deploy" to apply.`,
      };
    }

    const msg = `Prisma migration check failed: ${output}`;
    logger.error(msg);
    return { ok: false, pending: -1, applied: -1, message: msg };
  }

  const pendingMatch = stdout.match(/(\d+)\s+pending/i);
  const foundMatch = stdout.match(/(\d+)\s+migration/i);

  const pending = pendingMatch ? parseInt(pendingMatch[1], 10) : 0;
  const applied = foundMatch ? parseInt(foundMatch[1], 10) - pending : 0;
  const ok = pending === 0;

  const message = ok
    ? `Schema is in sync: ${applied} migration(s) applied, 0 pending.`
    : `Schema is out of sync: ${applied} applied, ${pending} pending. Run "npm run db:migrate" or "npx prisma migrate deploy" to apply.`;

  return { ok, pending, applied, message };
}
