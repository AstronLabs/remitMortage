// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import cron from "node-cron";
import { prisma } from "../services/db.js";
import logger from "../utils/logger.js";

const REFRESH_SCHEDULE = process.env.ANALYTICS_REFRESH_CRON_SCHEDULE || "*/5 * * * *";

let refreshTask: ReturnType<typeof cron.schedule> | null = null;

/**
 * Refreshes the protocol_analytics and monthly_volume_series materialized
 * views concurrently so reads are never blocked.
 *
 * REFRESH MATERIALIZED VIEW CONCURRENTLY requires a unique index on the
 * view — the migration creates one on `refreshed_at` / `month`.
 */
async function refreshMaterializedViews(): Promise<void> {
  const start = Date.now();
  try {
    const rawPrisma = prisma as any;
    if (typeof rawPrisma.$executeRawUnsafe !== "function") {
      return;
    }

    await rawPrisma.$executeRawUnsafe(
      "REFRESH MATERIALIZED VIEW CONCURRENTLY protocol_analytics",
    );
    await rawPrisma.$executeRawUnsafe(
      "REFRESH MATERIALIZED VIEW CONCURRENTLY monthly_volume_series",
    );

    const elapsed = Date.now() - start;
    logger.info("[analytics-refresh] Materialized views refreshed", { elapsedMs: elapsed });
  } catch (error) {
    const elapsed = Date.now() - start;
    logger.error("[analytics-refresh] Failed to refresh materialized views", {
      elapsedMs: elapsed,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Starts the cron job that refreshes analytics materialized views
 * on the configured schedule (default: every 5 minutes).
 */
export function startAnalyticsRefreshScheduler(): void {
  if (refreshTask) {
    logger.info("[analytics-refresh] Already running, ignoring start request.");
    return;
  }

  refreshTask = cron.schedule(
    REFRESH_SCHEDULE,
    async () => {
      await refreshMaterializedViews();
    },
    { timezone: "UTC" },
  );

  logger.info("[analytics-refresh] Started", { schedule: REFRESH_SCHEDULE });
}

/**
 * Stops the analytics refresh scheduler.
 */
export function stopAnalyticsRefreshScheduler(): void {
  if (refreshTask) {
    refreshTask.stop();
    refreshTask = null;
    logger.info("[analytics-refresh] Stopped.");
  }
}

/**
 * Performs an immediate refresh (e.g. on startup or admin endpoint).
 */
export async function refreshNow(): Promise<{ success: boolean; elapsedMs: number }> {
  const start = Date.now();
  await refreshMaterializedViews();
  const elapsed = Date.now() - start;
  return { success: true, elapsedMs: elapsed };
}
