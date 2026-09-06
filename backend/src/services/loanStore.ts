import { StrKey } from "@stellar/stellar-sdk";
import { prisma } from "./db.js";
import {
  diffLoanSnapshot,
  recordLoanChange,
  recordLoanCreation,
  type LoanSnapshot,
} from "./loanHistory.js";

// lightweight id generator to avoid adding dependencies
function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,9)}`;
}

export type LoanStatus =
  | "Draft"
  | "Pending"
  | "Approved"
  | "Rejected"
  | "Disbursing"
  | "Repaying"
  | "Completed"
  | "MANUAL_REVIEW";

/** Authorization state of an attached guarantor — mirrors the Prisma enum. */
export type GuarantorStatus = "Accepted" | "Rejected";

export interface LoanApplication {
  id: string;
  borrowerAddress: string;
  amount: string;
  status: LoanStatus;
  reason?: string;
  createdAt: string;
  updatedAt: string;
  /** Present only when a guarantor was attached to this loan. */
  guarantorAddress?: string;
  /** Present only when a guarantor was attached to this loan. */
  guarantorStatus?: GuarantorStatus;
}

/** Options for attaching a guarantor at application creation time. */
export interface GuarantorOptions {
  /** Guarantor's Stellar G-address. */
  address: string;
  /**
   * Hex-encoded Ed25519 signature produced by the guarantor over the
   * canonical commitment string (see services/guarantor.ts).
   */
  signature: string;
  /** Pre-verified status — caller is responsible for running verification. */
  status: GuarantorStatus;
}

function mapLoanApplication(record: any): LoanApplication {
  const app: LoanApplication = {
    id: record.id,
    borrowerAddress: record.applicant.stellarAddress,
    amount: String(record.principal),
    status: record.status,
    reason: record.reason ?? undefined,
    createdAt: record.createdAt.toISOString(),
    // updatedAt is not on the schema model; fall back to createdAt
    updatedAt: (record.updatedAt ?? record.createdAt).toISOString(),
  };

  if (record.guarantorAddress) {
    app.guarantorAddress = record.guarantorAddress;
    app.guarantorStatus = record.guarantorStatus ?? undefined;
  }

  return app;
}

async function findOrCreateApplicant(stellarAddress: string) {
  return prisma.applicant.upsert({
    where: { stellarAddress },
    update: { deletedAt: null },
    create: { stellarAddress },
  });
}

/**
 * Creates a new loan application.
 *
 * When `guarantor` is supplied the guarantor address and the pre-verified
 * status are stored.  The caller (route handler) is responsible for running
 * `verifyStellarGuarantorSignature` before calling this function and passing
 * the result as `guarantor.status`.
 *
 * No guarantor is attached when `guarantor` is omitted — existing
 * borrower-only behaviour is fully preserved.
 */
export async function createApplication(
  borrowerAddress: string,
  amount: string,
  guarantor?: GuarantorOptions
) {
  StrKey.decodeEd25519PublicKey(borrowerAddress);

  const applicant = await findOrCreateApplicant(borrowerAddress);
  const id = makeId();

  const record = await prisma.loanApplication.create({
    data: {
      id,
      applicantId: applicant.id,
      principal: Number(amount),
      status: "Pending",
      ...(guarantor
        ? {
            guarantorAddress: guarantor.address,
            guarantorSignature: guarantor.signature,
            guarantorStatus: guarantor.status,
          }
        : {}),
    },
    include: { applicant: true },
  });

  const application = mapLoanApplication(record);

  // Seed the audit trail with the creation snapshot so later point-in-time
  // reconstructions have a base state to replay changes onto.
  await recordLoanCreation(application.id, snapshotOf(application));

  return application;
}

/** The mutable slice of a loan application tracked by the audit trail. */
function snapshotOf(app: LoanApplication): LoanSnapshot {
  return {
    borrowerAddress: app.borrowerAddress,
    amount: app.amount,
    status: app.status,
    reason: app.reason,
  };
}

export async function getApplication(id: string) {
  const record = await prisma.loanApplication.findFirst({
    where: { id, deletedAt: null },
    include: { applicant: true },
  });

  return record ? mapLoanApplication(record) : null;
}

export async function getApplicationsByBorrower(address: string) {
  const records = await prisma.loanApplication.findMany({
    where: { deletedAt: null, applicant: { stellarAddress: address, deletedAt: null } },
    include: { applicant: true },
  });

  return records.map(mapLoanApplication);
}

export async function getPendingApplications() {
  const records = await prisma.loanApplication.findMany({
    where: { status: "Pending", deletedAt: null },
    include: { applicant: true },
  });

  return records.map(mapLoanApplication);
}

export async function listApplications() {
  const records = await prisma.loanApplication.findMany({
    where: { deletedAt: null },
    include: { applicant: true },
  });
  return records.map(mapLoanApplication);
}

export async function updateApplication(id: string, patch: Partial<LoanApplication>) {
  const existing = await prisma.loanApplication.findFirst({
    where: { id, deletedAt: null },
    include: { applicant: true },
  });
  if (!existing) return null;

  const before: LoanSnapshot = {
    borrowerAddress: existing.applicant.stellarAddress,
    amount: existing.principal,
    status: existing.status,
    reason: existing.reason ?? undefined,
  };

  if (patch.borrowerAddress) {
    await prisma.applicant.update({
      where: { id: existing.applicantId },
      data: { stellarAddress: patch.borrowerAddress },
    });
  }

  const updateData: {
    principal?: number;
    status?: LoanStatus;
    reason?: string | null;
    lastActivityAt?: Date;
    draftStaleNotifiedAt?: null;
  } = {};

  if (patch.amount !== undefined) updateData.principal = Number(patch.amount);
  if (patch.status !== undefined) updateData.status = patch.status;
  if (patch.reason !== undefined) updateData.reason = patch.reason ?? null;

  // Any edit to a still-Draft application counts as activity: reset the
  // inactivity clock and clear a pending stale notice, taking it out of
  // scope for the stale draft cleanup job.
  const resultingStatus = patch.status ?? existing.status;
  if (Object.keys(updateData).length && resultingStatus === "Draft") {
    updateData.lastActivityAt = new Date();
    updateData.draftStaleNotifiedAt = null;
  }

  const record = Object.keys(updateData).length
    ? await prisma.loanApplication.update({
        where: { id },
        data: updateData,
        include: { applicant: true },
      })
    : await prisma.loanApplication.findFirst({
        where: { id, deletedAt: null },
        include: { applicant: true },
      });

  if (!record) return null;

  const application = mapLoanApplication(record);

  // Append the field-level diff to the audit trail so this state transition
  // can be replayed during point-in-time reconstruction. No-op when nothing
  // tracked actually changed.
  await recordLoanChange(id, diffLoanSnapshot(before, snapshotOf(application)));

  return application;
}

/** Explicitly resumes a Draft flagged as stale, resetting its inactivity clock. */
export async function resumeDraftApplication(id: string) {
  const existing = await prisma.loanApplication.findFirst({
    where: { id, deletedAt: null, status: "Draft" },
  });
  if (!existing) return null;

  const record = await prisma.loanApplication.update({
    where: { id },
    data: { lastActivityAt: new Date(), draftStaleNotifiedAt: null },
    include: { applicant: true },
  });

  return mapLoanApplication(record);
}

/** Explicitly discards a Draft application (soft delete) before it would otherwise expire. */
export async function discardDraftApplication(id: string) {
  const existing = await prisma.loanApplication.findFirst({
    where: { id, deletedAt: null, status: "Draft" },
  });
  if (!existing) return null;

  const record = await prisma.loanApplication.update({
    where: { id },
    data: { deletedAt: new Date() },
    include: { applicant: true },
  });

  return mapLoanApplication(record);
}

export type BulkReviewDecision = "approve" | "reject";

export interface BulkReviewItem {
  applicationId: string;
  decision: BulkReviewDecision;
  reason?: string;
}

export interface BulkReviewResult {
  applicationId: string;
  decision: BulkReviewDecision;
  status: LoanStatus;
}

/**
 * Review applications independently while keeping each state change and its
 * compliance audit event in one database transaction. A rejected item does
 * not roll back successful decisions for other applications in the batch.
 */
export async function bulkReviewApplications(
  items: BulkReviewItem[],
  reviewerAddress: string,
  ipAddress?: string,
) {
  const results: BulkReviewResult[] = [];
  const failures: Array<{ applicationId: string; error: string }> = [];

  for (const item of items) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        const application = await tx.loanApplication.findFirst({
          where: { id: item.applicationId, deletedAt: null },
          include: { applicant: true },
        });

        if (!application) throw new Error("not_found");
        if (application.status !== "Pending") throw new Error("invalid_state");
        if (application.principal <= 0 || application.applicant.deletedAt !== null) {
          throw new Error("ineligible");
        }
        if (application.applicant.verificationStatus === "INELIGIBLE") {
          throw new Error("ineligible");
        }

        const status = item.decision === "approve" ? "Approved" : "Rejected";
        const updated = await tx.loanApplication.update({
          where: { id: item.applicationId },
          data: { status, statusUpdatedAt: new Date() },
          include: { applicant: true },
        });

        await tx.auditLog.create({
          data: {
            action: `loan_application.bulk_${item.decision}d`,
            actorAddress: reviewerAddress,
            ipAddress,
            metadata: {
              applicationId: item.applicationId,
              previousStatus: application.status,
              newStatus: status,
              decision: item.decision,
              reason: item.reason ?? null,
              reviewedAt: new Date().toISOString(),
              // Field-level change set, so point-in-time reconstruction can
              // replay this transition the same way it replays updates from
              // `updateApplication`.
              changes: { status: { from: application.status, to: status } },
            },
          },
        });

        return { applicationId: updated.id, decision: item.decision, status };
      });
      results.push(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "review_failed";
      failures.push({ applicationId: item.applicationId, error: message });
    }
  }

  return { results, failures };
}

export type BulkReviewDecision = "approve" | "reject";

export interface BulkReviewItem {
  applicationId: string;
  decision: BulkReviewDecision;
  reason?: string;
}

export interface BulkReviewResult {
  applicationId: string;
  decision: BulkReviewDecision;
  status: LoanStatus;
}

/**
 * Review applications independently while keeping each state change and its
 * compliance audit event in one database transaction. A rejected item does
 * not roll back successful decisions for other applications in the batch.
 */
export async function bulkReviewApplications(
  items: BulkReviewItem[],
  reviewerAddress: string,
  ipAddress?: string,
) {
  const results: BulkReviewResult[] = [];
  const failures: Array<{ applicationId: string; error: string }> = [];

  for (const item of items) {
    try {
      const result = await (prisma.$transaction as any)(async (tx: any) => {
        const application = await tx.loanApplication.findFirst({
          where: { id: item.applicationId, deletedAt: null },
          include: { applicant: true },
        });

        if (!application) throw new Error("not_found");
        if (application.status !== "Pending") throw new Error("invalid_state");
        if (application.principal <= 0 || application.applicant.deletedAt !== null) {
          throw new Error("ineligible");
        }
        if (application.applicant.verificationStatus === "INELIGIBLE") {
          throw new Error("ineligible");
        }

        const status = item.decision === "approve" ? "Approved" : "Rejected";
        const updated = await tx.loanApplication.update({
          where: { id: item.applicationId },
          data: { status, statusUpdatedAt: new Date() },
          include: { applicant: true },
        });

        await tx.auditLog.create({
          data: {
            action: `loan_application.bulk_${item.decision}d`,
            actorAddress: reviewerAddress,
            ipAddress,
            metadata: {
              applicationId: item.applicationId,
              previousStatus: application.status,
              newStatus: status,
              decision: item.decision,
              reason: item.reason ?? null,
              reviewedAt: new Date().toISOString(),
            },
          },
        });

        return { applicationId: updated.id, decision: item.decision, status };
      });
      results.push(result as BulkReviewResult);
    } catch (error) {
      const message = error instanceof Error ? error.message : "review_failed";
      failures.push({ applicationId: item.applicationId, error: message });
    }
  }

  return { results, failures };
}

// Simple escrow check: for demo purposes consider escrow "met" when requested amount is <= 5000
export function escrowTargetMetForAmount(amount: string) {
  const num = Number(amount);
  if (Number.isNaN(num) || num <= 0) return false;
  return num <= 5000;
}
