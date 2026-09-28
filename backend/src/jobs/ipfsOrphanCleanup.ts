/**
 * Automated Orphaned IPFS/Storage Object Cleanup Job
 *
 * Identifies CIDs that are no longer referenced by any live database record
 * and unpins them from Pinata, reclaiming storage.
 *
 * Safety rules
 * ────────────
 * 1. Grace period: a CID pinned less than ORPHAN_GRACE_PERIOD_MS ago is
 *    never touched, even if its referencing record has already been removed.
 *    This protects in-flight uploads where the proposal hasn't been created yet.
 *
 * 2. Referenced content is always preserved. Milestone evidence remains
 *    referenced while at least one durable proposal-to-CID ownership row exists.
 *    In-process proposals are also checked as a conservative fallback.
 *
 * 3. Already-unpinned CIDs (unpinnedAt set) are skipped.
 *
 * 4. The job is idempotent — re-running after a failure is safe.
 *
 * Schedule: daily at 03:00 UTC (configurable via IPFS_CLEANUP_CRON_SCHEDULE).
 */

import cron from "node-cron";
import logger from "../utils/logger.js";
import {
  hasMilestoneEvidenceReference,
  listActiveCids,
  markCidOrphan,
  markCidUnpinned,
  TrackedCidRecord,
} from "../services/ipfsCidTracker.js";
import { unpinEvidenceCid } from "../services/ipfsCleanup.js";
import { getProposal } from "../services/milestoneProposalStore.js";

// ── Configuration ────────────────────────────────────────────────────────────

/**
 * Minimum age (ms) a CID must have before it can be considered orphaned.
 * Default: 24 hours. Override via IPFS_ORPHAN_GRACE_PERIOD_HOURS env var.
 */
export function getGracePeriodMs(): number {
  const hours = parseInt(
    process.env.IPFS_ORPHAN_GRACE_PERIOD_HOURS ?? "24",
    10
  );
  return (isNaN(hours) ? 24 : Math.max(0, hours)) * 60 * 60 * 1000;
}

// ── Orphan detection ─────────────────────────────────────────────────────────

/**
 * Determines whether a tracked CID is still referenced by a live record.
 *
 * Extend this function when new referenceTypes are added (e.g. "kyc_document").
 */
export async function isCidReferenced(record: TrackedCidRecord): Promise<boolean> {
  if (record.referenceType === "milestone_evidence") {
    // A durable database owner wins over the tracker hint (which represents
    // only one of potentially several proposals for an identical CID).
    if (await hasMilestoneEvidenceReference(record.cid)) return true;

    // Also protect a proposal created in this process if the ownership write
    // was unavailable. Database lookup errors throw, causing fail-closed skip.
    const proposal = getProposal(record.referenceId);
    return Boolean(
      proposal &&
      proposal.evidenceCid === record.cid &&
      (proposal.status === "Open" || proposal.status === "Passed")
    );
  }

  // Unknown reference type — conservatively treat as referenced
  logger.warn("[IPFSOrphanCleanup] Unknown referenceType — treating as referenced", {
    referenceType: record.referenceType,
    cid: record.cid,
  });
  return true;
}

// ── Run result ───────────────────────────────────────────────────────────────

export interface OrphanCleanupResult {
  checked: number;
  skippedGracePeriod: number;
  referenced: number;
  orphaned: number;
  reclaimed: number;
  unpinned: number;
  failed: number;
  storageErrors: number;
  durationMs: number;
}

// ── Core job logic ───────────────────────────────────────────────────────────

export async function runOrphanCleanup(): Promise<OrphanCleanupResult> {
  const startedAt = Date.now();
  const gracePeriodMs = getGracePeriodMs();

  logger.info("[IPFSOrphanCleanup] Starting orphan cleanup job", {
    gracePeriodHours: gracePeriodMs / (60 * 60 * 1000),
  });

  const result: OrphanCleanupResult = {
    checked: 0,
    skippedGracePeriod: 0,
    referenced: 0,
    orphaned: 0,
    reclaimed: 0,
    unpinned: 0,
    failed: 0,
    storageErrors: 0,
    durationMs: 0,
  };

  let activeCids: TrackedCidRecord[];
  try {
    activeCids = await listActiveCids();
  } catch (err) {
    result.failed++;
    logger.error("[IPFSOrphanCleanup] Failed to load active CIDs — aborting", { err });
    result.durationMs = Date.now() - startedAt;
    logger.info("[IPFSOrphanCleanup] Cleanup complete", {
      checked: result.checked,
      skippedGracePeriod: result.skippedGracePeriod,
      referenced: result.referenced,
      orphaned: result.orphaned,
      reclaimed: result.reclaimed,
      errors: result.failed,
      storageErrors: result.storageErrors,
      durationMs: result.durationMs,
    });
    return result;
  }

  result.checked = activeCids.length;

  for (const record of activeCids) {
    try {
      // Rule 1: grace period — never touch recently-pinned CIDs
      const ageMs = Date.now() - record.pinnedAt.getTime();
      if (ageMs < gracePeriodMs) {
        result.skippedGracePeriod++;
        continue;
      }

      // Rule 2: referenced content must be preserved
      if (await isCidReferenced(record)) {
        result.referenced++;
        continue;
      }

      // CID is orphaned — mark it before attempting the unpin so the record
      // reflects orphan status even if the unpin itself fails.
      result.orphaned++;
      await markCidOrphan(record.cid);

      // Rule 3: unpin from Pinata and update the tracker
      await unpinEvidenceCid(record.cid, record.referenceId, { throwOnError: true });
      await markCidUnpinned(record.cid);
      result.unpinned++;
      result.reclaimed++;

      logger.info("[IPFSOrphanCleanup] Unpinned orphaned CID", {
        cid: record.cid,
        referenceType: record.referenceType,
        referenceId: record.referenceId,
        pinnedAt: record.pinnedAt.toISOString(),
        ageHours: (ageMs / (60 * 60 * 1000)).toFixed(1),
      });
    } catch (err) {
      result.failed++;
      result.storageErrors++;
      logger.error("[IPFSOrphanCleanup] Error processing CID", {
        cid: record.cid,
        err,
      });
    }
  }

  result.durationMs = Date.now() - startedAt;

  logger.info("[IPFSOrphanCleanup] Cleanup complete", {
    checked: result.checked,
    skippedGracePeriod: result.skippedGracePeriod,
    referenced: result.referenced,
    orphaned: result.orphaned,
    reclaimed: result.reclaimed,
    unpinned: result.unpinned,
    errors: result.failed,
    storageErrors: result.storageErrors,
    durationMs: result.durationMs,
  });

  return result;
}

// ── Scheduler ────────────────────────────────────────────────────────────────

let cleanupTask: ReturnType<typeof cron.schedule> | null = null;

export function startIpfsOrphanCleanupScheduler(): void {
  if (cleanupTask) {
    logger.info("[IPFSOrphanCleanup] Scheduler already running, ignoring start request.");
    return;
  }

  const schedule =
    process.env.IPFS_CLEANUP_CRON_SCHEDULE ?? "0 3 * * *"; // 03:00 UTC daily

  if (process.env.ENABLE_IPFS_ORPHAN_CLEANUP === "false") {
    logger.info("[IPFSOrphanCleanup] Disabled via ENABLE_IPFS_ORPHAN_CLEANUP=false");
    return;
  }

  cleanupTask = cron.schedule(
    schedule,
    async () => {
      await runOrphanCleanup();
    },
    { timezone: "UTC" }
  );

  logger.info("[IPFSOrphanCleanup] Scheduler started", { schedule });
}

export function stopIpfsOrphanCleanupScheduler(): void {
  if (cleanupTask) {
    cleanupTask.stop();
    cleanupTask = null;
    logger.info("[IPFSOrphanCleanup] Scheduler stopped.");
  }
}
