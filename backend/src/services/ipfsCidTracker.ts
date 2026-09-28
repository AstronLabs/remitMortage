/**
 * CID tracker — persists a record for every CID pinned by the application.
 *
 * The orphan-cleanup job queries this table to find CIDs whose referenced
 * record (proposal, document, …) no longer exists. By recording pins here at
 * upload time we get a reliable, DB-backed inventory without having to call
 * the Pinata listing API (which requires a paid plan and has rate limits).
 */

import { prisma } from "./db.js";
import logger from "../utils/logger.js";

export interface TrackCidInput {
  cid: string;
  /** e.g. "milestone_evidence", "kyc_document" */
  referenceType: string;
  /** ID of the owning record (proposalId, documentId, …) */
  referenceId: string;
}

/** Record/reactivate a freshly pinned CID without preserving stale cleanup state. */
export async function trackCid(input: TrackCidInput): Promise<void> {
  try {
    await prisma.trackedCid.upsert({
      where: { cid: input.cid },
      update: {
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        pinnedAt: new Date(),
        unpinnedAt: null,
        markedOrphanAt: null,
      },
      create: {
        cid: input.cid,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
      },
    });
  } catch (err) {
    // Non-fatal: tracking failure must never block the upload path.
    logger.warn("[CIDTracker] Failed to record CID in tracker", {
      cid: input.cid,
      err,
    });
  }
}

/** Mark a CID as unpinned in the tracker (called after successful unpin). */
export async function markCidUnpinned(cid: string): Promise<void> {
  await prisma.trackedCid.updateMany({
    where: { cid, unpinnedAt: null },
    data: { unpinnedAt: new Date() },
  });
}

/** Mark a CID as orphaned (referenced record no longer exists). */
export async function markCidOrphan(cid: string): Promise<void> {
  await prisma.trackedCid.update({
    where: { cid },
    data: { markedOrphanAt: new Date() },
  });
}

/** Persist a live proposal-to-evidence relationship before acknowledging it. */
export async function addMilestoneEvidenceReference(
  proposalId: string,
  cid: string
): Promise<void> {
  await prisma.milestoneEvidenceReference.upsert({
    where: { proposalId_cid: { proposalId, cid } },
    update: {},
    create: { proposalId, cid },
  });
}

/** Remove one proposal's ownership; other proposals may still reference the CID. */
export async function removeMilestoneEvidenceReference(
  proposalId: string,
  cid: string
): Promise<void> {
  await prisma.milestoneEvidenceReference.deleteMany({
    where: { proposalId, cid },
  });
}

/** Returns whether at least one durable proposal still owns the CID. */
export async function hasMilestoneEvidenceReference(
  cid: string,
  excludingProposalId?: string
): Promise<boolean> {
  const reference = await prisma.milestoneEvidenceReference.findFirst({
    where: {
      cid,
      ...(excludingProposalId ? { proposalId: { not: excludingProposalId } } : {}),
    },
    select: { proposalId: true },
  });
  return reference !== null;
}

export interface TrackedCidRecord {
  id: string;
  cid: string;
  referenceType: string;
  referenceId: string;
  pinnedAt: Date;
  unpinnedAt: Date | null;
  markedOrphanAt: Date | null;
}

/**
 * Returns all CIDs that have not been unpinned yet.
 * The caller is responsible for filtering by grace period.
 */
export async function listActiveCids(): Promise<TrackedCidRecord[]> {
  return prisma.trackedCid.findMany({
    where: { unpinnedAt: null },
    orderBy: { pinnedAt: "asc" },
  });
}
