// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { StrKey } from "@stellar/stellar-sdk";
import { prisma } from "./db.js";
import {
  diffLoanSnapshot,
  LOAN_MANUAL_STATUS_CHANGE_ACTION,
  LOAN_UPDATED_ACTION,
  recordLoanChange,
  recordLoanCreation,
  type LoanSnapshot,
} from "./loanHistory.js";
import type { ManualStatusChangeReason } from "./manualStatusChangeReason.js";
import { autoAssignApplicationReviewer } from "./assignmentQueue.js";
import { priceNewOffer } from "./rateSheet.js";
import { recordStageEnter, transitionReviewStage } from "./loanReviewStages.js";

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
export const GUARANTOR_STATUSES = ["Accepted", "Rejected"] as const;
export type GuarantorStatus = (typeof GUARANTOR_STATUSES)[number];

export interface LoanApplication {
  id: string;
  borrowerAddress: string;
  amount: string;
  loanType?: string;
  status: LoanStatus;
  reason?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Optimistic-locking token (issue #846). Incremented on every update
   * written through this module. Send the value you last read back as
   * `expectedVersion` so a concurrent reviewer's decision surfaces as a
   * {@link StaleVersionError} (HTTP 409) instead of being overwritten.
   */
  version: number;
  /** Present only when a guarantor was attached to this loan. */
  guarantorAddress?: string;
  /** Present only when a guarantor was attached to this loan. */
  guarantorStatus?: GuarantorStatus;
  /** Why the application is held for a reviewer, e.g. DUPLICATE_TAX_ID. */
  manualReviewReason?: string;
  /** Current servicer of record; absent while the originator services the loan. */
  servicer?: string;
  servicerContact?: string;
  /** Rate this offer was priced at, in basis points. */
  interestRateBps?: number;
  /** Rate sheet version that priced this offer; absent for pre-versioning loans. */
  rateSheetVersionId?: string;
}

/**
 * Thrown when an update guarded by `expectedVersion` races another writer
 * (issue #846). Carries the record as it exists now so the route can return
 * 409 with the current state and the client can re-read, re-apply and retry.
 */
export class StaleVersionError extends Error {
  readonly code = "version_conflict" as const;
  /** Lets the global error handler fall back to 409 if a route forgets to catch. */
  readonly statusCode = 409;
  /** The record as it stands after the concurrent write landed. */
  readonly current: LoanApplication;
  readonly expectedVersion: number;

  constructor(current: LoanApplication, expectedVersion: number) {
    super(
      `Loan application ${current.id} was updated concurrently: expected version ` +
        `${expectedVersion}, current version ${current.version}`
    );
    this.name = "StaleVersionError";
    this.current = current;
    this.expectedVersion = expectedVersion;
  }
}

/** Options for {@link updateApplication}. */
export interface UpdateApplicationOptions {
  /**
   * Optimistic-lock guard (issue #846). When supplied, the update only
   * succeeds if the record still has this exact version; otherwise a
   * {@link StaleVersionError} carrying the current record is thrown and no
   * write happens.
   */
  expectedVersion?: number;
  /**
   * Marks this update as a manual, operator-initiated status change (issue
   * #1102). The reason and actor are written to the activity history next to
   * the status transition. Automated workflow updates omit this.
   */
  manualStatusChange?: {
    reason: ManualStatusChangeReason;
    actorAddress?: string;
    ipAddress?: string;
  };
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
    manualReviewReason: record.manualReviewReason ?? undefined,
    servicer: record.servicer ?? undefined,
    servicerContact: record.servicerContact ?? undefined,
    interestRateBps: record.interestRateBps ?? undefined,
    rateSheetVersionId: record.rateSheetVersionId ?? undefined,
    // Rows migrated before issue #846 existed default to version 1, matching
    // the column default; mocked/legacy records without the field do too.
    version: typeof record.version === "number" ? record.version : 1,
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

  // Issue #746: price from the rate sheet in effect right now and record which
  // version that was, so the offer can be traced back to its exact rates.
  const pricing = await priceNewOffer(applicant.creditScore, new Date());

  const record = await prisma.loanApplication.create({
    data: {
      id,
      applicantId: applicant.id,
      principal: Number(amount),
      status: "Pending",
      ...(pricing
        ? { interestRateBps: pricing.interestRateBps, rateSheetVersionId: pricing.rateSheetVersionId }
        : {}),
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

  // Open the application's first review-stage interval (issue #1047).
  await recordStageEnter(undefined, application.id, application.status, new Date(application.createdAt));

  // Issue #621: distribute the new application round-robin across active
  // reviewers. Best-effort — a queue failure never blocks submission.
  await autoAssignApplicationReviewer(application.id);

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

export async function updateApplication(
  id: string,
  patch: Partial<LoanApplication>,
  options: UpdateApplicationOptions = {}
) {
  const { expectedVersion, manualStatusChange } = options;
  const existing = await prisma.loanApplication.findFirst({
    where: { id, deletedAt: null },
    include: { applicant: true },
  });
  if (!existing) return null;

  // Optimistic lock (issue #846): fail fast — before any write — when the
  // caller's snapshot is already behind a concurrent reviewer's decision.
  if (expectedVersion !== undefined && existing.version !== expectedVersion) {
    throw new StaleVersionError(mapLoanApplication(existing), expectedVersion);
  }

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
    version?: { increment: number };
  } = {};

  if (patch.amount !== undefined) updateData.principal = Number(patch.amount);
  if (patch.status !== undefined) updateData.status = patch.status;
  if (patch.reason !== undefined) updateData.reason = patch.reason ?? null;

  // Any edit to a still-Draft application counts as activity: reset the
  // inactivity clock and clear a pending stale notice, taking it out of
  // scope for the stale draft cleanup job.
  const hasFieldChanges = Object.keys(updateData).length > 0;
  const resultingStatus = patch.status ?? existing.status;
  if (hasFieldChanges && resultingStatus === "Draft") {
    updateData.lastActivityAt = new Date();
    updateData.draftStaleNotifiedAt = null;
  }

  // Every write through this API bumps the optimistic-lock token, so the
  // next stale update is detectable (issue #846).
  updateData.version = { increment: 1 };

  let record: any;
  try {
    record = await prisma.loanApplication.update({
      // With `expectedVersion` the guard is re-checked atomically in the
      // UPDATE's WHERE clause, closing the read-then-write race window.
      where: {
        id,
        ...(expectedVersion !== undefined ? { version: expectedVersion } : {}),
      },
      data: updateData,
      include: { applicant: true },
    });
  } catch (error) {
    // Prisma reports "record not found" (P2025) when the guarded WHERE no
    // longer matches — i.e. a concurrent write landed between the read above
    // and this UPDATE. Translate that into the same conflict payload.
    if (expectedVersion !== undefined) {
      const current = await prisma.loanApplication.findFirst({
        where: { id, deletedAt: null },
        include: { applicant: true },
      });
      if (current && current.version !== expectedVersion) {
        throw new StaleVersionError(mapLoanApplication(current), expectedVersion);
      }
    }
    throw error;
  }

  if (!record) return null;

  const application = mapLoanApplication(record);

  // Append the field-level diff to the audit trail so this state transition
  // can be replayed during point-in-time reconstruction. No-op when nothing
  // tracked actually changed.
  // A manual status change carries its operator-chosen reason (issue #1102)
  // in the same audit row as the transition, so the history shows why.
  const isManualStatusChange = manualStatusChange !== undefined && application.status !== before.status;
  await recordLoanChange(
    id,
    diffLoanSnapshot(before, snapshotOf(application)),
    isManualStatusChange
      ? {
          actorAddress: manualStatusChange.actorAddress,
          ipAddress: manualStatusChange.ipAddress,
          statusChangeReason: manualStatusChange.reason,
        }
      : {},
    isManualStatusChange ? LOAN_MANUAL_STATUS_CHANGE_ACTION : LOAN_UPDATED_ACTION,
  );

  // Time the review-stage transition (issue #1047): close the interval for the
  // status being left and open one for the status being entered. Guarded on a
  // genuine status change so re-saving an unchanged application opens nothing.
  if (application.status !== before.status) {
    await transitionReviewStage(undefined, id, application.status, new Date());
  }

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
    data: { lastActivityAt: new Date(), draftStaleNotifiedAt: null, version: { increment: 1 } },
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
    data: { deletedAt: new Date(), version: { increment: 1 } },
    include: { applicant: true },
  });

  return mapLoanApplication(record);
}

export type BulkReviewDecision = "approve" | "reject";

export interface BulkReviewItem {
  applicationId: string;
  decision: BulkReviewDecision;
  reason?: string;
  /** Operator-chosen reason code for this manual decision (issue #1102). */
  statusChangeReason?: ManualStatusChangeReason;
  /**
   * Optimistic-lock guard (issue #846). When supplied, the decision is only
   * applied if the record still sits at this version; a mismatch records a
   * `version_conflict` failure carrying the current state instead of
   * overwriting the concurrent reviewer's decision.
   */
  version?: number;
}

export interface BulkReviewResult {
  applicationId: string;
  decision: BulkReviewDecision;
  status: LoanStatus;
  /** Version after the write — send it back as the next `version`. */
  version: number;
}

export interface BulkReviewFailure {
  applicationId: string;
  /** Short failure code: not_found | invalid_state | ineligible | version_conflict | ... */
  error: string;
  /** Present for version_conflict: the record's version right now. */
  currentVersion?: number;
  /** Present for version_conflict: the record's current state (HTTP 409 payload). */
  application?: LoanApplication;
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
  const failures: BulkReviewFailure[] = [];

  for (const item of items) {
    try {
      const result = await prisma.$transaction(async (tx: any) => {
        const application = await tx.loanApplication.findFirst({
          where: { id: item.applicationId, deletedAt: null },
          include: { applicant: true },
        });

        if (!application) throw new Error("not_found");

        // Optimistic lock (issue #846): reject inside the same transaction
        // that performs the write, so a stale decision never lands.
        if (item.version !== undefined && application.version !== item.version) {
          throw new StaleVersionError(mapLoanApplication(application), item.version);
        }

        if (application.status !== "Pending") throw new Error("invalid_state");
        if (application.principal <= 0 || application.applicant.deletedAt !== null) {
          throw new Error("ineligible");
        }
        if (application.applicant.verificationStatus === "INELIGIBLE") {
          throw new Error("ineligible");
        }

        const status = item.decision === "approve" ? "Approved" : "Rejected";
        const updated = await tx.loanApplication.update({
          where: {
            id: item.applicationId,
            ...(item.version !== undefined ? { version: item.version } : {}),
          },
          data: { status, statusUpdatedAt: new Date(), version: { increment: 1 } },
          include: { applicant: true },
        });

        await tx.auditLog.create({
          data: {
            action: item.decision === "approve" ? "loan_application.bulk_approved" : "loan_application.bulk_rejected",
            actorAddress: reviewerAddress,
            ipAddress,
            metadata: {
              applicationId: item.applicationId,
              previousStatus: application.status,
              newStatus: status,
              decision: item.decision,
              reason: item.reason ?? null,
              ...(item.statusChangeReason ? { statusChangeReason: item.statusChangeReason } : {}),
              reviewedAt: new Date().toISOString(),
              // Field-level change set, so point-in-time reconstruction can
              // replay this transition the same way it replays updates from
              // `updateApplication`.
              changes: { status: { from: application.status, to: status } },
            },
          },
        });

        // Time the review-stage transition inside the same transaction
        // (issue #1047): close the Pending interval, open the decided stage.
        await transitionReviewStage(tx, item.applicationId, status, new Date());

        return {
          applicationId: updated.id,
          decision: item.decision,
          status,
          // Version after the write (issue #846) — echoed back so the next
          // batched decision can chain from it. Falls back to the expected
          // increment when a mock/legacy record omits the column.
          version:
            typeof updated.version === "number"
              ? updated.version
              : (application.version ?? 0) + 1,
        };
      });
      results.push(result);
    } catch (error) {
      if (error instanceof StaleVersionError) {
        failures.push({
          applicationId: item.applicationId,
          error: error.code,
          currentVersion: error.current.version,
          application: error.current,
        });
        continue;
      }
      // P2025 on the guarded WHERE: a concurrent write landed between this
      // transaction's read and its UPDATE (issue #846).
      if (item.version !== undefined && (error as any)?.code === "P2025") {
        const current = await getApplication(item.applicationId);
        failures.push({
          applicationId: item.applicationId,
          error: "version_conflict",
          currentVersion: current?.version,
          application: current ?? undefined,
        });
        continue;
      }
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
