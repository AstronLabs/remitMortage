import cron from "node-cron";
import logger from "../utils/logger.js";
import { startPartitionManager } from "./partitionManager.js";
import { runRepaymentAudit } from "./repaymentAudit.js";
import { runKycExpiryReminderJob } from "./kycExpiryReminder.js";
import { runEscrowReconciliation } from "./escrowReconciliation.js";
import { runApplicationSlaMonitorJob } from "./applicationSlaMonitor.js";
import { runAdminPortfolioDigestJob } from "./adminPortfolioDigest.js";
import { runSessionTokenPurgeJob } from "./sessionTokenPurge.js";
import { runOrphanedRecordCleanupJob } from "./orphanedRecordCleanup.js";
import { startAnalyticsRefreshScheduler, stopAnalyticsRefreshScheduler } from "./analyticsRefresh.js";

let schedulerTask: ReturnType<typeof cron.schedule> | null = null;
let kycExpiryTask: ReturnType<typeof cron.schedule> | null = null;
let escrowReconciliationTask: ReturnType<typeof cron.schedule> | null = null;
let applicationSlaTask: ReturnType<typeof cron.schedule> | null = null;
let adminDigestTask: ReturnType<typeof cron.schedule> | null = null;
let sessionTokenPurgeTask: ReturnType<typeof cron.schedule> | null = null;
let orphanedRecordCleanupTask: ReturnType<typeof cron.schedule> | null = null;
let staleDraftCleanupTask: ReturnType<typeof cron.schedule> | null = null;

export function startScheduler() {
  if (schedulerTask) {
    console.log("[Scheduler] Already running, ignoring start request.");
    return;
  }

  startPartitionManager();

  // Daily at midnight UTC: repayment audit
  schedulerTask = cron.schedule("0 0 * * *", async () => {
    console.log("[Scheduler] Triggering repayment audit job...");
    await runRepaymentAudit();
  }, { timezone: "UTC" });

  // Daily at 04:00 UTC: Session token auto-purge (configurable retention)
  const sessionPurgeSchedule = process.env.SESSION_TOKEN_PURGE_CRON_SCHEDULE || "0 4 * * *";
  sessionTokenPurgeTask = cron.schedule(sessionPurgeSchedule, async () => {
    console.log("[Scheduler] Triggering session token purge job...");
    await runSessionTokenPurgeJob();
  }, { timezone: "UTC" });

  // Daily at 05:00 UTC: soft-deleted borrower and loan record purge
  const orphanedCleanupSchedule = process.env.ORPHANED_RECORD_CLEANUP_CRON_SCHEDULE || "0 5 * * *";
  orphanedRecordCleanupTask = cron.schedule(orphanedCleanupSchedule, async () => {
    console.log("[Scheduler] Triggering orphaned record cleanup job...");
    await runOrphanedRecordCleanupJob();
  }, { timezone: "UTC" });

  // Daily at 08:00 UTC: KYC document expiry reminders
  const kycSchedule = process.env.KYC_EXPIRY_CRON_SCHEDULE || "0 8 * * *";
  kycExpiryTask = cron.schedule(kycSchedule, async () => {
    console.log("[Scheduler] Triggering KYC expiry reminder job...");
    await runKycExpiryReminderJob();
  }, { timezone: "UTC" });

  // Every 4 hours: escrow balance reconciliation
  const reconcileSchedule = process.env.ESCROW_RECONCILIATION_CRON_SCHEDULE || "0 */4 * * *";
  escrowReconciliationTask = cron.schedule(reconcileSchedule, async () => {
    console.log("[Scheduler] Triggering escrow reconciliation job...");
    await runEscrowReconciliation();
  }, { timezone: "UTC" });

  // Hourly: application SLA monitor scan
  const slaSchedule = process.env.APPLICATION_SLA_CRON_SCHEDULE || "0 * * * *";
  applicationSlaTask = cron.schedule(slaSchedule, async () => {
    console.log("[Scheduler] Triggering application SLA monitor job...");
    await runApplicationSlaMonitorJob();
  }, { timezone: "UTC" });

  // Weekly (Mon 08:00 UTC) by default: admin portfolio summary digest.
  // Set ADMIN_PORTFOLIO_DIGEST_CRON_SCHEDULE to "0 8 * * *" for a daily cadence.
  const digestSchedule =
    process.env.ADMIN_PORTFOLIO_DIGEST_CRON_SCHEDULE || "0 8 * * 1";
  adminDigestTask = cron.schedule(digestSchedule, async () => {
    console.log("[Scheduler] Triggering admin portfolio digest job...");
    await runAdminPortfolioDigestJob();
  }, { timezone: "UTC" });

  // Start the materialized view refresh scheduler (every 5 minutes by default)
  startAnalyticsRefreshScheduler();

  console.log(
    "[Scheduler] Started: repayment audit, session token purge, orphaned record cleanup, KYC expiry reminder, escrow reconciliation, application SLA monitor, admin portfolio digest, and analytics refresh jobs scheduled."
  );
}

export function stopScheduler() {
  if (schedulerTask) {
    schedulerTask.stop();
    schedulerTask = null;
  }
  if (sessionTokenPurgeTask) {
    sessionTokenPurgeTask.stop();
    sessionTokenPurgeTask = null;
  }
  if (orphanedRecordCleanupTask) {
    orphanedRecordCleanupTask.stop();
    orphanedRecordCleanupTask = null;
  }
  if (kycExpiryTask) {
    kycExpiryTask.stop();
    kycExpiryTask = null;
  }
  if (escrowReconciliationTask) {
    escrowReconciliationTask.stop();
    escrowReconciliationTask = null;
  }
  if (applicationSlaTask) {
    applicationSlaTask.stop();
    applicationSlaTask = null;
  }
  if (adminDigestTask) {
    adminDigestTask.stop();
    adminDigestTask = null;
  }
  stopAnalyticsRefreshScheduler();
  console.log("[Scheduler] Stopped.");
}
