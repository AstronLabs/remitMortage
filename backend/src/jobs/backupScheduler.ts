// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import cron from "node-cron";
import { createBackupService } from "../services/databaseBackup.js";
import logger from "../utils/logger.js";

/**
 * Automated Database Backup Scheduler
 *
 * Runs daily backups at 2:00 AM UTC by default.
 * Schedule can be customized via BACKUP_CRON_SCHEDULE environment variable.
 */
export function startBackupScheduler(): void {
  // Default: Daily at 2:00 AM UTC
  // Format: minute hour day month weekday
  const schedule = process.env.BACKUP_CRON_SCHEDULE || "0 2 * * *";

  const enabled = process.env.ENABLE_AUTO_BACKUP !== "false";

  if (!enabled) {
    logger.info("Automated database backups are disabled");
    return;
  }

  logger.info("Starting automated backup scheduler", {
    schedule,
    timezone: "UTC",
  });

  cron.schedule(
    schedule,
    async () => {
      logger.info("Executing scheduled database backup");

      try {
        const backupService = createBackupService();
        const result = await backupService.executeBackup();

        logger.info("Scheduled backup completed successfully", {
          backupKey: result.backupKey,
          sizeBytes: result.size,
          sizeMB: (result.size / (1024 * 1024)).toFixed(2),
        });
      } catch (error) {
        logger.error("Scheduled backup failed", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });

        // TODO: Send alert notification (email, Slack, PagerDuty, etc.)
        // await sendBackupFailureAlert(error);
      }
    },
    {
      timezone: "UTC",
    }
  );

  logger.info("Backup scheduler started successfully");
}

/**
 * Execute an immediate backup (for testing or manual trigger)
 */
export async function executeImmediateBackup(): Promise<void> {
  logger.info("Executing immediate database backup");

  const backupService = createBackupService();
  const result = await backupService.executeBackup();

  logger.info("Immediate backup completed", {
    backupKey: result.backupKey,
    sizeMB: (result.size / (1024 * 1024)).toFixed(2),
  });
}

/**
 * Weekly cleanup of backups older than 30 days. Archives them to cold
 * storage (AWS Glacier / GCS Archive) and removes from hot storage.
 * Runs every Sunday at 3:00 AM UTC by default.
 */
export function startBackupCleanupScheduler(): void {
  const schedule = process.env.BACKUP_CLEANUP_CRON_SCHEDULE || "0 3 * * 0";
  const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS) || 30;

  const enabled = process.env.ENABLE_BACKUP_CLEANUP !== "false";

  if (!enabled) {
    logger.info("Automated backup cleanup is disabled");
    return;
  }

  logger.info("Starting backup cleanup scheduler", { schedule, retentionDays });

  cron.schedule(
    schedule,
    async () => {
      logger.info("Executing scheduled backup cleanup");

      try {
        const backupService = createBackupService();
        const result = await backupService.cleanupOldBackups(retentionDays);

        logger.info("Backup cleanup completed", {
          archived: result.archived,
          failed: result.failed,
        });
      } catch (error) {
        logger.error("Backup cleanup failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    { timezone: "UTC" },
  );

  logger.info("Backup cleanup scheduler started successfully");
}
