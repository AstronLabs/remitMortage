// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { prisma } from "../services/db.js";
import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";

export interface SessionTokenPurgeSummary {
  deletedCount: number;
  retentionDays: number;
  cutoff: Date;
  durationMs: number;
}

/**
 * Purges expired and revoked session tokens that have exceeded the retention window.
 *
 * Rules:
 * - Retention cutoff is `now - (retentionDays * 24 hours)`.
 * - Tokens whose `expiresAt` is before the cutoff are deleted.
 * - Active (non-expired) tokens (`expiresAt >= now`) and recently expired tokens
 *   within the retention window (`expiresAt >= cutoff`) are NEVER deleted.
 *
 * @param overrideRetentionDays Optional override for retention days (defaults to config value).
 */
export async function runSessionTokenPurgeJob(
  overrideRetentionDays?: number
): Promise<SessionTokenPurgeSummary> {
  const startTime = Date.now();
  const config = loadConfig();
  const retentionDays =
    typeof overrideRetentionDays === "number" && overrideRetentionDays >= 0
      ? overrideRetentionDays
      : config.sessionTokenRetentionDays;

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  logger.info("[SessionTokenPurge] Starting session token auto-purge sweep", {
    retentionDays,
    cutoff: cutoff.toISOString(),
  });

  try {
    const result = await prisma.sessionToken.deleteMany({
      where: {
        expiresAt: {
          lt: cutoff,
        },
      },
    });

    const durationMs = Date.now() - startTime;
    const summary: SessionTokenPurgeSummary = {
      deletedCount: result.count,
      retentionDays,
      cutoff,
      durationMs,
    };

    logger.info("[SessionTokenPurge] Session token purge completed successfully", {
      deletedCount: summary.deletedCount,
      retentionDays: summary.retentionDays,
      cutoff: summary.cutoff.toISOString(),
      durationMs: summary.durationMs,
    });

    return summary;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    logger.error("[SessionTokenPurge] Error occurred during session token purge", {
      error,
      retentionDays,
      cutoff: cutoff.toISOString(),
      durationMs,
    });
    throw error;
  }
}
