// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { prisma } from "../services/db.js";
import logger from "../utils/logger.js";

export interface ScoreLineageCleanupSummary {
  deletedCount: number;
  cutoff: Date;
  durationMs: number;
}

/**
 * Deletes score-lineage records whose retention window has elapsed (issue
 * #982). Each record carries the `expiresAt` stamped when the score was
 * computed, so the cleanup never shortens or extends an existing window.
 *
 * @param now Optional clock override, for deterministic tests.
 */
export async function runScoreLineageCleanupJob(now: Date = new Date()): Promise<ScoreLineageCleanupSummary> {
  const startTime = Date.now();

  logger.info("[ScoreLineageCleanup] Starting score lineage purge", {
    cutoff: now.toISOString(),
  });

  try {
    const result = await prisma.scoreLineage.deleteMany({
      where: { expiresAt: { lte: now } },
    });

    const summary: ScoreLineageCleanupSummary = {
      deletedCount: result.count,
      cutoff: now,
      durationMs: Date.now() - startTime,
    };

    logger.info("[ScoreLineageCleanup] Score lineage purge completed", {
      deletedCount: summary.deletedCount,
      cutoff: summary.cutoff.toISOString(),
      durationMs: summary.durationMs,
    });

    return summary;
  } catch (error) {
    logger.error("[ScoreLineageCleanup] Score lineage purge failed", {
      error,
      cutoff: now.toISOString(),
      durationMs: Date.now() - startTime,
    });
    throw error;
  }
}
