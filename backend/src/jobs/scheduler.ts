// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import cron from "node-cron";
import logger from "../utils/logger.js";
import { startPartitionManager } from "./partitionManager.js";
import { runRepaymentAudit } from "./repaymentAudit.js";
import { runKycExpiryReminderJob } from "./kycExpiryReminder.js";
import { runInvestorReverificationJob } from "./investorReverificationReminder.js";
import { runEscrowReconciliation } from "./escrowReconciliation.js";
import { runApplicationSlaMonitorJob } from "./applicationSlaMonitor.js";
import { runAdminPortfolioDigestJob } from "./adminPortfolioDigest.js";
import { runSlowQueryDigestJob } from "./slowQueryDigest.js";
import { runSessionTokenPurgeJob } from "./sessionTokenPurge.js";
import { runOrphanedRecordCleanupJob } from "./orphanedRecordCleanup.js";
import { startAnalyticsRefreshScheduler, stopAnalyticsRefreshScheduler } from "./analyticsRefresh.js";
import { runSuspiciousActivityScan } from "../services/suspiciousActivity.js";
import { runRateLimitAuditJob } from "./rateLimitAudit.js";
import { runDeadlockDetectionJob } from "./deadlockDetection.js";
import { runTableBloatMonitorJob } from "./tableBloatMonitor.js";
import { runUnusedIndexAuditJob } from "./unusedIndexAudit.js";
import { runQueryKillerJob } from "./queryKiller.js";
import { runFourEyesApprovalExpiryJob } from "./fourEyesApprovalExpiry.js";
import { applyDueServicingTransfers } from "../services/loanServicing.js";
import { prisma } from "../services/db.js";
import { createPrismaSlowQueryStore } from "../services/slowQueryLog.js";
import { runDataQualityAuditJob } from "./dataQualityAudit.js";
import { runAuditChainVerificationJob } from "./auditChainVerification.js";
import { runOutboxCleanupOnce, runOutboxRelayOnce } from "./outboxRelay.js";
import { runInvestorPositionReconciliation } from "./investorPositionReconciliation.js";
import { scheduledJob } from "../services/jobLeaderElection.js";

let schedulerTask: ReturnType<typeof cron.schedule> | null = null;
let kycExpiryTask: ReturnType<typeof cron.schedule> | null = null;
let investorReverificationTask: ReturnType<typeof cron.schedule> | null = null;
let escrowReconciliationTask: ReturnType<typeof cron.schedule> | null = null;
let applicationSlaTask: ReturnType<typeof cron.schedule> | null = null;
let adminDigestTask: ReturnType<typeof cron.schedule> | null = null;
let slowQueryDigestTask: ReturnType<typeof cron.schedule> | null = null;
let sessionTokenPurgeTask: ReturnType<typeof cron.schedule> | null = null;
let orphanedRecordCleanupTask: ReturnType<typeof cron.schedule> | null = null;
let staleDraftCleanupTask: ReturnType<typeof cron.schedule> | null = null;
let suspiciousActivityTask: ReturnType<typeof cron.schedule> | null = null;
let rateLimitAuditTask: ReturnType<typeof cron.schedule> | null = null;
let deadlockDetectionTask: ReturnType<typeof cron.schedule> | null = null;
let unusedIndexAuditTask: ReturnType<typeof cron.schedule> | null = null;
let staleFlagAuditTask: ReturnType<typeof cron.schedule> | null = null;
let servicingTransferTask: ReturnType<typeof cron.schedule> | null = null;
let tableBloatMonitorTask: ReturnType<typeof cron.schedule> | null = null;
let queryKillerTask: ReturnType<typeof cron.schedule> | null = null;
let fourEyesApprovalExpiryTask: ReturnType<typeof cron.schedule> | null = null;
let dataQualityAuditTask: ReturnType<typeof cron.schedule> | null = null;
let auditChainVerificationTask: ReturnType<typeof cron.schedule> | null = null;
let outboxRelayTask: ReturnType<typeof cron.schedule> | null = null;
let outboxCleanupTask: ReturnType<typeof cron.schedule> | null = null;
let investorPositionReconciliationTask: ReturnType<typeof cron.schedule> | null = null;

export function startScheduler() {
  if (schedulerTask) {
    console.log("[Scheduler] Already running, ignoring start request.");
    return;
  }

  startPartitionManager();

  // Nightly read-only scan; clean and failing summaries are retained in AuditLog.
  const dataQualitySchedule = process.env.DATA_QUALITY_AUDIT_CRON_SCHEDULE || "0 6 * * *";
  dataQualityAuditTask = cron.schedule(dataQualitySchedule, scheduledJob("data-quality-audit", async () => {
    try {
      await runDataQualityAuditJob();
    } catch (error) {
      logger.error("[Scheduler] Data quality audit failed", { error });
    }
  }), { timezone: "UTC" });

  // Daily at midnight UTC: repayment audit
  schedulerTask = cron.schedule("0 0 * * *", scheduledJob("repayment-audit", async () => {
    console.log("[Scheduler] Triggering repayment audit job...");
    await runRepaymentAudit();
  }), { timezone: "UTC" });

  // Daily at 04:00 UTC: Session token auto-purge (configurable retention)
  const sessionPurgeSchedule = process.env.SESSION_TOKEN_PURGE_CRON_SCHEDULE || "0 4 * * *";
  sessionTokenPurgeTask = cron.schedule(sessionPurgeSchedule, scheduledJob("session-token-purge", async () => {
    console.log("[Scheduler] Triggering session token purge job...");
    await runSessionTokenPurgeJob();
  }), { timezone: "UTC" });

  // Every 15 minutes: expire overdue four-eyes approval requests (issue #841)
  const fourEyesExpirySchedule = process.env.FOUR_EYES_APPROVAL_EXPIRY_CRON_SCHEDULE || "*/15 * * * *";
  fourEyesApprovalExpiryTask = cron.schedule(fourEyesExpirySchedule, scheduledJob("four-eyes-approval-expiry", async () => {
    console.log("[Scheduler] Triggering four-eyes approval expiry sweep...");
    await runFourEyesApprovalExpiryJob();
  }), { timezone: "UTC" });

  // Daily at 05:00 UTC: soft-deleted borrower and loan record purge
  const orphanedCleanupSchedule = process.env.ORPHANED_RECORD_CLEANUP_CRON_SCHEDULE || "0 5 * * *";
  orphanedRecordCleanupTask = cron.schedule(orphanedCleanupSchedule, scheduledJob("orphaned-record-cleanup", async () => {
    console.log("[Scheduler] Triggering orphaned record cleanup job...");
    await runOrphanedRecordCleanupJob();
  }), { timezone: "UTC" });

  // Daily at 08:00 UTC: KYC document expiry reminders
  const kycSchedule = process.env.KYC_EXPIRY_CRON_SCHEDULE || "0 8 * * *";
  kycExpiryTask = cron.schedule(kycSchedule, scheduledJob("kyc-expiry", async () => {
    console.log("[Scheduler] Triggering KYC expiry reminder job...");
    await runKycExpiryReminderJob();
  }), { timezone: "UTC" });

  // Daily at 08:30 UTC: accredited investor re-verification reminders
  const reverificationSchedule = process.env.INVESTOR_REVERIFICATION_CRON_SCHEDULE || "30 8 * * *";
  investorReverificationTask = cron.schedule(reverificationSchedule, scheduledJob("investor-reverification", async () => {
    try {
      await runInvestorReverificationJob();
    } catch (error) {
      logger.error("[Scheduler] Investor re-verification sweep failed", { error });
    }
  }), { timezone: "UTC" });

  // Every 4 hours: escrow balance reconciliation
  const reconcileSchedule = process.env.ESCROW_RECONCILIATION_CRON_SCHEDULE || "0 */4 * * *";
  escrowReconciliationTask = cron.schedule(reconcileSchedule, scheduledJob("escrow-reconciliation", async () => {
    console.log("[Scheduler] Triggering escrow reconciliation job...");
    await runEscrowReconciliation();
  }), { timezone: "UTC" });

  // Hourly: application SLA monitor scan
  const slaSchedule = process.env.APPLICATION_SLA_CRON_SCHEDULE || "0 * * * *";
  applicationSlaTask = cron.schedule(slaSchedule, scheduledJob("application-sla", async () => {
    console.log("[Scheduler] Triggering application SLA monitor job...");
    await runApplicationSlaMonitorJob();
  }), { timezone: "UTC" });

  // Weekly (Mon 08:00 UTC) by default: admin portfolio summary digest.
  // Set ADMIN_PORTFOLIO_DIGEST_CRON_SCHEDULE to "0 8 * * *" for a daily cadence.
  const digestSchedule =
    process.env.ADMIN_PORTFOLIO_DIGEST_CRON_SCHEDULE || "0 8 * * 1";
  adminDigestTask = cron.schedule(digestSchedule, scheduledJob("admin-digest", async () => {
    console.log("[Scheduler] Triggering admin portfolio digest job...");
    await runAdminPortfolioDigestJob();
  }), { timezone: "UTC" });

  // Weekly (Mon 09:00 UTC) by default: ranked slow-query digest for the team.
  // Set SLOW_QUERY_DIGEST_CRON_SCHEDULE to override the cadence.
  const slowQuerySchedule =
    process.env.SLOW_QUERY_DIGEST_CRON_SCHEDULE || "0 9 * * 1";
  slowQueryDigestTask = cron.schedule(slowQuerySchedule, scheduledJob("slow-query-digest", async () => {
    console.log("[Scheduler] Triggering slow query digest job...");
    await runSlowQueryDigestJob({ store: createPrismaSlowQueryStore(prisma) });
  }), { timezone: "UTC" });

  const amlSchedule = process.env.AML_SCAN_CRON_SCHEDULE || "*/15 * * * *";
  suspiciousActivityTask = cron.schedule(amlSchedule, scheduledJob("suspicious-activity", async () => {
    try {
      await runSuspiciousActivityScan();
    } catch (error) {
      logger.error("[Scheduler] Suspicious activity scan failed", { error });
    }
  }), { timezone: "UTC" });

  const auditSchedule = process.env.RATE_LIMIT_AUDIT_CRON_SCHEDULE || "0 * * * *"; // Hourly by default
  rateLimitAuditTask = cron.schedule(auditSchedule, scheduledJob("rate-limit-audit", async () => {
    console.log("[Scheduler] Triggering rate limit audit job...");
    await runRateLimitAuditJob();
  }), { timezone: "UTC" });

  const deadlockSchedule = process.env.DEADLOCK_DETECTION_CRON_SCHEDULE || "*/5 * * * *"; // Every 5 minutes
  deadlockDetectionTask = cron.schedule(deadlockSchedule, scheduledJob("deadlock-detection", async () => {
    await runDeadlockDetectionJob();
  }), { timezone: "UTC" });

  // Weekly (Mon 10:00 UTC) by default: unused-index candidate report.
  // Report-only — never drops an index. See docs/UNUSED_INDEX_REVIEW.md.
  const unusedIndexSchedule = process.env.UNUSED_INDEX_AUDIT_CRON_SCHEDULE || "0 10 * * 1";
  unusedIndexAuditTask = cron.schedule(unusedIndexSchedule, scheduledJob("unused-index-audit", async () => {
    try {
      console.log("[Scheduler] Triggering unused index audit job...");
      await runUnusedIndexAuditJob();
    } catch (error) {
      logger.error("[Scheduler] Unused index audit job failed", { error });
    }
  }), { timezone: "UTC" });

  // Every minute: terminate runaway queries past the duration threshold (issue #736).
  const queryKillerSchedule = process.env.QUERY_KILLER_CRON_SCHEDULE || "*/1 * * * *";
  queryKillerTask = cron.schedule(queryKillerSchedule, scheduledJob("query-killer", async () => {
    try {
      await runQueryKillerJob();
    } catch (error) {
      logger.error("[Scheduler] Query killer job failed", { error });
    }
  }), { timezone: "UTC" });

  // Every 15 minutes: apply loan servicing transfers whose effective date has passed
  const servicingSchedule = process.env.LOAN_SERVICING_TRANSFER_CRON_SCHEDULE || "*/15 * * * *";
  servicingTransferTask = cron.schedule(servicingSchedule, scheduledJob("servicing-transfer", async () => {
    try {
      await applyDueServicingTransfers();
    } catch (error) {
      logger.error("[Scheduler] Loan servicing transfer job failed", { error });
    }
  }), { timezone: "UTC" });

  // Every 30 minutes: scan for table bloat and manually VACUUM critical tables
  const tableBloatSchedule = process.env.TABLE_BLOAT_MONITOR_CRON_SCHEDULE || "*/30 * * * *";
  tableBloatMonitorTask = cron.schedule(tableBloatSchedule, scheduledJob("table-bloat-monitor", async () => {
    try {
      await runTableBloatMonitorJob();
    } catch (error) {
      logger.error("[Scheduler] Table bloat monitor job failed", { error });
    }
  }), { timezone: "UTC" });

  // Every 6 hours: verify the tamper-evident audit-log hash chain (issue #861)
  const auditChainSchedule = process.env.AUDIT_CHAIN_VERIFY_CRON_SCHEDULE || "0 */6 * * *";
  auditChainVerificationTask = cron.schedule(auditChainSchedule, scheduledJob("audit-chain-verification", async () => {
    try {
      await runAuditChainVerificationJob();
    } catch (error) {
      logger.error("[Scheduler] Audit chain verification job failed", { error });
    }
  }), { timezone: "UTC" });

  // Every minute: publish pending transactional-outbox rows (issue #858). The
  // relay is at-least-once; rows stay pending if the queue is unavailable.
  const outboxRelaySchedule = process.env.OUTBOX_RELAY_CRON_SCHEDULE || "* * * * *";
  outboxRelayTask = cron.schedule(outboxRelaySchedule, scheduledJob("outbox-relay", async () => {
    try {
      await runOutboxRelayOnce();
    } catch (error) {
      logger.error("[Scheduler] Outbox relay job failed", { error });
    }
  }), { timezone: "UTC" });

  // Daily at 03:30 UTC: delete published outbox rows past the retention window.
  const outboxCleanupSchedule = process.env.OUTBOX_CLEANUP_CRON_SCHEDULE || "30 3 * * *";
  outboxCleanupTask = cron.schedule(outboxCleanupSchedule, scheduledJob("outbox-cleanup", async () => {
    try {
      await runOutboxCleanupOnce();
    } catch (error) {
      logger.error("[Scheduler] Outbox cleanup job failed", { error });
    }
  }), { timezone: "UTC" });

  // Start the materialized view refresh scheduler (every 5 minutes by default)
  startAnalyticsRefreshScheduler();

  const investorSchedule = process.env.INVESTOR_POSITION_RECONCILIATION_CRON_SCHEDULE || "30 1 * * *";
  investorPositionReconciliationTask = cron.schedule(investorSchedule, async () => {
    console.log("[Scheduler] Triggering investor position reconciliation job...");
    await runInvestorPositionReconciliation();
  }, { timezone: "UTC" });

  console.log(
    "[Scheduler] Started: repayment audit, session purge, KYC expiry reminder, escrow reconciliation, investor reconciliation, application SLA monitor, and admin portfolio digest jobs scheduled."
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
  if (investorReverificationTask) {
    investorReverificationTask.stop();
    investorReverificationTask = null;
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
  if (investorPositionReconciliationTask) {
    investorPositionReconciliationTask.stop();
    investorPositionReconciliationTask = null;
  }
  console.log("[Scheduler] Stopped.");
}
