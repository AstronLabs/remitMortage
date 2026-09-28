// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Late payment fee waiver request workflow for hardship cases (issue #749).
 *
 * Borrower flow: submit a structured hardship request capturing reason +
 * supporting context against a loan with an outstanding late-fee balance,
 * then track its PENDING -> APPROVED | PARTIAL | DENIED status.
 *
 * Admin flow: review the PENDING queue, apply the documented approval
 * criteria, and record a consistent approve / deny / partial-waiver decision.
 * Every decision records amount waived + reason + approver against the loan
 * via AuditLog so the full trail is auditable.
 */

import { prisma } from "./db.js";
import { logAudit } from "./audit.js";
import logger from "../utils/logger.js";

/** Documented hardship categories accepted on waiver requests. */
export const HARDSHIP_REASONS = [
  "JOB_LOSS",
  "MEDICAL_EMERGENCY",
  "NATURAL_DISASTER",
  "REDUCED_INCOME",
  "BEREAVEMENT",
  "OTHER",
] as const;

export type HardshipReason = (typeof HARDSHIP_REASONS)[number];
export type FeeWaiverStatus = "PENDING" | "APPROVED" | "PARTIAL" | "DENIED";
export type WaiverDecision = "APPROVED" | "DENIED" | "PARTIAL";

/** Current documented waiver policy version. Bumped when criteria change. */
export const WAIVER_POLICY_VERSION = "waiver-policy-v1";

/**
 * Documented approval criteria (also surfaced to admins via
 * `getWaiverApprovalCriteria`). Kept as data so tests and the admin UI can
 * assert the exact rules applied to every decision.
 */
export const WAIVER_APPROVAL_CRITERIA = {
  policyVersion: WAIVER_POLICY_VERSION,
  eligibleHardships: [...HARDSHIP_REASONS],
  rules: [
    "Borrower must describe a genuine hardship with supporting context (>= 20 chars).",
    "Loan must carry an outstanding lateFeeBalance > 0 at request time.",
    "Only one PENDING request per loan at a time.",
    "APPROVED waives the full outstanding late fee; PARTIAL waives a positive amount strictly below it; DENIED waives 0.",
    "PARTIAL requires a documented rationale referencing the criteria.",
  ],
} as const;

export function getWaiverApprovalCriteria() {
  return WAIVER_APPROVAL_CRITERIA;
}

export class FeeWaiverError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400
  ) {
    super(message);
  }
}

export interface CreateWaiverInput {
  loanId: string;
  borrowerAddress: string;
  hardshipReason: unknown;
  context: unknown;
  ipAddress?: string;
}

function requireHardshipReason(value: unknown): HardshipReason {
  if (typeof value !== "string" || !(HARDSHIP_REASONS as readonly string[]).includes(value)) {
    throw new FeeWaiverError(
      "invalid_hardship_reason",
      `hardshipReason must be one of: ${HARDSHIP_REASONS.join(", ")}`
    );
  }
  return value as HardshipReason;
}

function requireContext(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 20) {
    throw new FeeWaiverError(
      "invalid_context",
      "context is required and must be at least 20 characters describing the hardship"
    );
  }
  if (value.trim().length > 5000) {
    throw new FeeWaiverError("invalid_context", "context must be at most 5000 characters");
  }
  return value.trim();
}

/** Borrower submits a hardship waiver request against a loan. */
export async function createWaiverRequest(input: CreateWaiverInput) {
  const hardshipReason = requireHardshipReason(input.hardshipReason);
  const context = requireContext(input.context);

  const loan: any = await (prisma as any).loanApplication.findFirst({
    where: { id: input.loanId, deletedAt: null },
  });
  if (!loan) {
    throw new FeeWaiverError("not_found", "Loan application not found", 404);
  }
  const borrowerAddr =
    loan?.applicant?.stellarAddress ?? loan?.borrowerAddress ?? null;
  if (
    borrowerAddr &&
    String(borrowerAddr).toLowerCase() !== String(input.borrowerAddress).toLowerCase()
  ) {
    throw new FeeWaiverError("forbidden", "Request must be filed by the owning borrower", 403);
  }
  const outstanding = Number(loan.lateFeeBalance ?? 0);
  if (!Number.isFinite(outstanding) || outstanding <= 0) {
    throw new FeeWaiverError(
      "no_late_fee",
      "Loan has no outstanding late-fee balance to waive",
      409
    );
  }

  const existing = await (prisma as any).lateFeeWaiverRequest.findFirst({
    where: { loanApplicationId: input.loanId, status: "PENDING" },
  });
  if (existing) {
    throw new FeeWaiverError(
      "request_pending",
      "A waiver request is already pending for this loan",
      409
    );
  }

  const created = await (prisma as any).lateFeeWaiverRequest.create({
    data: {
      loanApplicationId: input.loanId,
      borrowerAddress: input.borrowerAddress,
      hardshipReason,
      context,
      requestedAmount: outstanding,
      status: "PENDING",
      policyVersion: WAIVER_POLICY_VERSION,
    },
  });

  logAudit({
    action: "LATE_FEE_WAIVER_REQUESTED",
    actorAddress: input.borrowerAddress,
    ipAddress: input.ipAddress,
    metadata: {
      loanId: input.loanId,
      requestId: created.id,
      hardshipReason,
      requestedAmount: outstanding,
      policyVersion: WAIVER_POLICY_VERSION,
    },
  });

  logger.info(`[fee-waiver] request ${created.id} filed for loan ${input.loanId}`);
  return created;
}

/** Borrower-trackable status listing for one loan (newest last). */
export async function listWaiverRequestsForLoan(loanId: string) {
  return (prisma as any).lateFeeWaiverRequest.findMany({
    where: { loanApplicationId: loanId },
    orderBy: { createdAt: "asc" },
  });
}

/** Admin review queue: all PENDING requests, oldest first. */
export async function listPendingWaiverQueue() {
  return (prisma as any).lateFeeWaiverRequest.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
}

export interface DecideWaiverInput {
  requestId: string;
  decision: unknown;
  waivedAmount?: unknown;
  decisionReason: unknown;
  decidedBy: string;
  ipAddress?: string;
}

/**
 * Admin decision: APPROVED (full), PARTIAL (strict subset) or DENIED (zero).
 * Applies the late-fee credit to the loan and records the audit trail.
 */
export async function decideWaiverRequest(input: DecideWaiverInput) {
  const { requestId, decidedBy } = input;
  const decision = input.decision;
  if (decision !== "APPROVED" && decision !== "DENIED" && decision !== "PARTIAL") {
    throw new FeeWaiverError(
      "invalid_decision",
      "decision must be one of APPROVED, DENIED, PARTIAL"
    );
  }
  const decisionReason =
    typeof input.decisionReason === "string" ? input.decisionReason.trim() : "";
  if (decisionReason.length < 10) {
    throw new FeeWaiverError(
      "invalid_decision_reason",
      "decisionReason is required (min 10 chars) and must reference the approval criteria"
    );
  }
  if (!decidedBy || typeof decidedBy !== "string") {
    throw new FeeWaiverError("missing_decider", "decidedBy admin identity is required", 403);
  }

  const request: any = await (prisma as any).lateFeeWaiverRequest.findUnique({
    where: { id: requestId },
  });
  if (!request) {
    throw new FeeWaiverError("not_found", "Waiver request not found", 404);
  }
  if (request.status !== "PENDING") {
    throw new FeeWaiverError(
      "already_decided",
      `Request already decided (${request.status})`,
      409
    );
  }

  const loan: any = await (prisma as any).loanApplication.findFirst({
    where: { id: request.loanApplicationId, deletedAt: null },
  });
  if (!loan) {
    throw new FeeWaiverError("loan_not_found", "Loan application not found", 404);
  }
  const outstanding = Number(loan.lateFeeBalance ?? 0);

  let waivedAmount = 0;
  if (decision === "APPROVED") {
    waivedAmount = outstanding;
    if (waivedAmount <= 0) {
      throw new FeeWaiverError("no_late_fee", "Nothing left to waive on this loan", 409);
    }
  } else if (decision === "PARTIAL") {
    waivedAmount = Number(input.waivedAmount);
    if (!Number.isFinite(waivedAmount) || waivedAmount <= 0) {
      throw new FeeWaiverError(
        "invalid_waived_amount",
        "waivedAmount must be a positive number for PARTIAL decisions"
      );
    }
    if (waivedAmount >= outstanding) {
      throw new FeeWaiverError(
        "invalid_waived_amount",
        "PARTIAL waivedAmount must be strictly less than the outstanding late fee; use APPROVED for a full waiver"
      );
    }
  } else {
    waivedAmount = 0;
  }

  const newLateFeeBalance = Math.max(0, outstanding - waivedAmount);

  const updated = await (prisma as any).lateFeeWaiverRequest.update({
    where: { id: requestId },
    data: {
      status: decision,
      waivedAmount,
      decidedBy,
      decisionReason,
      decidedAt: new Date(),
    },
  });

  await (prisma as any).loanApplication.update({
    where: { id: request.loanApplicationId },
    data: { lateFeeBalance: newLateFeeBalance },
  });

  logAudit({
    action: "LATE_FEE_WAIVER_DECIDED",
    actorAddress: decidedBy,
    ipAddress: input.ipAddress,
    metadata: {
      loanId: request.loanApplicationId,
      requestId,
      decision,
      requestedAmount: request.requestedAmount,
      outstandingAtDecision: outstanding,
      waivedAmount,
      newLateFeeBalance,
      hardshipReason: request.hardshipReason,
      decisionReason,
      policyVersion: request.policyVersion ?? WAIVER_POLICY_VERSION,
    },
  });

  logger.info(
    `[fee-waiver] request ${requestId} ${decision} by ${decidedBy} waived=${waivedAmount}`
  );
  return { request: updated, waivedAmount, newLateFeeBalance };
}
