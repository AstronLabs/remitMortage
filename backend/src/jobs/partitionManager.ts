import cron from "node-cron";
import logger from "../utils/logger.js";
import { prisma } from "../services/db.js";

async function managePartitions() {
  logger.info("[partition-manager] Running partition management job");

  try {
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    
    const nextNextMonth = new Date(nextMonth);
    nextNextMonth.setMonth(nextNextMonth.getMonth() + 1);

    const partitionName = `AuditLog_${nextMonth.getFullYear()}_${(nextMonth.getMonth() + 1).toString().padStart(2, '0')}`;
    const startStr = `${nextMonth.getFullYear()}-${(nextMonth.getMonth() + 1).toString().padStart(2, '0')}-01`;
    const endStr = `${nextNextMonth.getFullYear()}-${(nextNextMonth.getMonth() + 1).toString().padStart(2, '0')}-01`;

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "${partitionName}" 
      PARTITION OF "AuditLog" 
      FOR VALUES FROM ('${startStr}') TO ('${endStr}');
    `);

    logger.info(`[partition-manager] Created/verified partition ${partitionName}`);

    // Retention: drop partitions older than 12 months
    const oldMonth = new Date();
    oldMonth.setMonth(oldMonth.getMonth() - 12);
    const oldPartitionName = `AuditLog_${oldMonth.getFullYear()}_${(oldMonth.getMonth() + 1).toString().padStart(2, '0')}`;
    
    await prisma.$executeRawUnsafe(`
      DROP TABLE IF EXISTS "${oldPartitionName}";
    `);

    logger.info(`[partition-manager] Dropped partition ${oldPartitionName} if it existed`);

  } catch (error) {
    logger.error("[partition-manager] Failed to manage partitions", { error });
  }
}

export function startPartitionManager() {
  // Run on the 1st of every month at midnight
  cron.schedule("0 0 1 * *", managePartitions);
  logger.info("[partition-manager] Scheduled monthly partition management job");
}
