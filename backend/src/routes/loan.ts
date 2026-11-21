// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router, Response } from "express";
import { StrKey } from "@stellar/stellar-sdk";
import logger from "../utils/logger.js";
import { validatePositiveNumber } from "../middleware/validate.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import {
  createApplication,
  getApplication,
  getApplicationsByBorrower,
  getPendingApplications,
  updateApplication,
  resumeDraftApplication,
  discardDraftApplication,
  withdrawApplication,
  getReviewQueueMetrics,
  MAX_WITHDRAWAL_REASON_LENGTH,
  escrowTargetMetForAmount,
  StaleVersionError,
} from "../services/loanStore.js";
import {
  clearApplicationProgress,
  getApplicationProgress,
  InvalidProgressError,
  parseProgressInput,
  saveApplicationProgress,
} from "../services/applicationProgress.js";
import { applyAutoRejectionIfNeeded } from "../services/autoRejectionRuleStore.js";
import {
  verifyStellarGuarantorSignature,
  buildGuarantorCommitment,
} from "../services/guarantor.js";
import { queueNotification } from "../services/notification.js";
import { notifyWatchersOfOpenedOffering } from "../services/offeringWatchlist.js";
import { hasExpiredKycDocuments } from "../jobs/kycExpiryReminder.js";
import { prisma } from "../services/db.js";
import {
  findTaxIdMatches,
  recordApplicantTaxIdHash,
  DUPLICATE_TAX_ID_REVIEW_REASON,
} from "../services/taxIdDedup.js";
import { reconstructLoanApplicationAt } from "../services/loanHistory.js";
import {
  describeManualStatusChangeReason,
  parseManualStatusChangeReason,
} from "../services/manualStatusChangeReason.js";
import {
  getLoanActivityTimeline,
  InvalidActivityCursorError,
} from "../services/loanActivityTimeline.js";
import {
  checkDuplicateApplicants,
  logReviewerDecision,
  ApplicantFields,
} from "../utils/fuzzyMatch.js";
import {
  isAdminRequest,
  requireBorrowerAddressOwnership,
  requireLoanAdmin,
  requireLoanOwnership,
} from "../security/requireResourceOwnership.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

export const loanRouter = Router();

const REQUIRED_DOCUMENTS_BY_LOAN_TYPE: Record<string, string[]> = {
  purchase: ["identity", "income", "bank_statement", "property_contract"],
  construction: ["identity", "income", "bank_statement", "construction_plan"],
};

// ── Optimistic locking (issue #846) ─────────────────────────────────────────
//
// Every reviewer decision must echo back the application version the reviewer
// was looking at (`expectedVersion`). A missing/invalid token is a 400; a
// token that no longer matches the record is a 409 carrying the current
// state, so the client re-reads and re-applies instead of silently
// overwriting a concurrent decision.

/** Validates the optimistic-lock token; returns null when absent/invalid. */
function parseExpectedVersion(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : null;
}

/** 409 body: what the client sent, what the record holds now, and the record. */
function versionConflictResponse(res: Response, expectedVersion: number, current: { version: number }) {
  return res.status(409).json({
    error: "version_conflict",
    message:
      `Application was modified concurrently: expected version ${expectedVersion}, ` +
      `current version ${current.version}. Fetch the latest state and retry with the current version.`,
    expectedVersion,
    currentVersion: current.version,
    application: current,
  });
}

/** The 400 returned when a decision endpoint is called without the token. */
function missingExpectedVersionResponse(res: Response) {
  return res.status(400).json({
    error: "missing_field",
    field: "expectedVersion",
    message:
      "expectedVersion is required: send the version of the application you reviewed (integer >= 1) so concurrent decisions cannot overwrite each other.",
  });
}

// POST /api/loan/apply
loanRouter.post("/apply", idempotencyMiddleware, validatePositiveNumber("amount"), async (req, res) => {
  try {
    const { borrowerAddress, amount, fullName, address, idDocumentNumber, taxId } = req.body ?? {};

      if (!borrowerAddress) {
        return res.status(400).json({
          error: "missing_field",
          field: "borrowerAddress",
          message: "borrowerAddress is required",
        });
      }

      try {
        StrKey.decodeEd25519PublicKey(borrowerAddress);
      } catch {
        return res.status(400).json({
          error: "invalid_address",
          field: "borrowerAddress",
          message: "Invalid Stellar G-address",
        });
      }

    // Block loan submissions when any KYC document is expired
    const applicant = await prisma.applicant.findFirst({ where: { stellarAddress: borrowerAddress, deletedAt: null } });
    if (applicant && await hasExpiredKycDocuments(applicant.id)) {
      return res.status(403).json({
        error: "kyc_documents_expired",
        message: "One or more of your KYC documents have expired. Please renew them before submitting a loan application.",
      });
    }

    const escrowOk = escrowTargetMetForAmount(amount);
    if (!escrowOk) {
      return res.status(400).json({ error: "escrow_target_not_met", message: "Escrow target not reached for borrower" });
    }

    // Issue #496: Duplicate Applicant Detection via Fuzzy Matching
    const currentFields: ApplicantFields = {
      fullName: fullName || applicant?.taxId || undefined,
      address: address || undefined,
      idDocumentNumber: idDocumentNumber || undefined,
      taxId: taxId || applicant?.taxId || undefined,
    };

    let dupStatus: "Pending" | "MANUAL_REVIEW" = "Pending";
    let dupDetails: any = null;

    if (currentFields.fullName || currentFields.address || currentFields.idDocumentNumber || currentFields.taxId) {
      const allApplicants = await prisma.applicant.findMany({ where: { deletedAt: null } });
      const candidates: ApplicantFields[] = allApplicants.map((a: any) => ({
        id: a.id,
        fullName: a.taxId || undefined,
        taxId: a.taxId || undefined,
      }));

      const dupCheck = checkDuplicateApplicants(currentFields, candidates);
      if (dupCheck.isDuplicate) {
        dupStatus = "MANUAL_REVIEW";
        dupDetails = dupCheck;
        logger.warn(
          `Application for borrower ${borrowerAddress} flagged for MANUAL_REVIEW due to high similarity duplicate (score: ${dupCheck.highestScore})`
        );
      }
    }

    // Issue #692: exact SSN/tax ID match against other applicants, via a keyed
    // hash so the raw identifier is never stored or logged.
    const taxIdMatches = taxId ? await findTaxIdMatches(String(taxId), borrowerAddress) : [];

    const app = await createApplication(borrowerAddress, String(amount));
    if (taxId) {
      await recordApplicantTaxIdHash(borrowerAddress, String(taxId));
    }
    if (taxIdMatches.length > 0) {
      await prisma.loanApplication.update({
        where: { id: app.id },
        data: { manualReviewReason: DUPLICATE_TAX_ID_REVIEW_REASON, version: { increment: 1 } },
      });
      app.manualReviewReason = DUPLICATE_TAX_ID_REVIEW_REASON;
      logger.warn(
        `Application ${app.id} held for manual review: tax ID matches ${taxIdMatches.length} other applicant(s)`
      );
    }

    if (dupStatus === "MANUAL_REVIEW") {
      await updateApplication(app.id, { status: "MANUAL_REVIEW" });
      app.status = "MANUAL_REVIEW";
      return res.status(201).json({ ...app, duplicateCheck: dupDetails });
    }

    // Held applications skip auto-rejection so a reviewer makes the call.
    if (app.manualReviewReason) {
      return res.status(201).json({ ...app, duplicateCheck: dupDetails });
    }

    const applicantRecord = await prisma.applicant.findFirst({
      where: { stellarAddress: borrowerAddress, deletedAt: null },
    });
    if (applicantRecord) {
      const notifyEmail = req.body?.email || `${borrowerAddress}@example.com`;
      const { autoRejected, evaluation } = await applyAutoRejectionIfNeeded(
        app.id,
        applicantRecord.id,
        Number(amount),
        notifyEmail
      );

      if (autoRejected) {
        const rejected = await getApplication(app.id);
        return res.status(422).json({
          error: "auto_rejected",
          message: "Application failed baseline eligibility rules.",
          application: rejected,
          autoRejection: evaluation,
        });
      }
    }

    return res.status(201).json({ ...app, duplicateCheck: dupDetails });
  } catch (error) {
    logger.error("Loan apply error", { error });
    return res.status(500).json({ error: "failed_to_create_application" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/loan/borrower/:address
// ---------------------------------------------------------------------------
loanRouter.get("/borrower/:address", async (req, res) => {
  const address = String(req.params?.address ?? "");
  try {
    StrKey.decodeEd25519PublicKey(address);
  } catch {
    return res
      .status(400)
      .json({ error: "invalid_address", field: "address", message: "Invalid Stellar G-address" });
  }
  // Issue #760: borrowers may only list their own applications (admins exempt).
  if (!requireBorrowerAddressOwnership(req as AuthenticatedRequest, res, address)) return;
  const apps = await getApplicationsByBorrower(address);
  return res.json(apps);
});

// ---------------------------------------------------------------------------
// GET/PUT/DELETE /api/loan/progress  (issue #1110)
//
// Save point for the caller's in-progress multi-step application. Always
// scoped to the authenticated wallet — there is no address or id parameter —
// so progress saved on one device is available on any other the applicant
// signs in from.
// ---------------------------------------------------------------------------
function callerWallet(req: AuthenticatedRequest, res: Response): string | null {
  const wallet = req.user?.walletAddress;
  if (!wallet) {
    res.status(401).json({ error: "unauthorized", message: "Authentication required" });
    return null;
  }
  return wallet;
}

loanRouter.get("/progress", async (req, res) => {
  const wallet = callerWallet(req as AuthenticatedRequest, res);
  if (!wallet) return;
  try {
    const progress = await getApplicationProgress(wallet);
    if (!progress) return res.status(404).json({ error: "no_saved_progress" });
    return res.json(progress);
  } catch (err) {
    logger.error("Load application progress error", { err });
    return res.status(500).json({ error: "progress_load_failed" });
  }
});

loanRouter.put("/progress", async (req, res) => {
  const wallet = callerWallet(req as AuthenticatedRequest, res);
  if (!wallet) return;
  try {
    const input = parseProgressInput(req.body);
    const saved = await saveApplicationProgress(wallet, input);
    return res.json(saved);
  } catch (err) {
    if (err instanceof InvalidProgressError) {
      return res.status(400).json({ error: err.code, field: err.field, message: err.message });
    }
    logger.error("Save application progress error", { err });
    return res.status(500).json({ error: "progress_save_failed" });
  }
});

loanRouter.delete("/progress", async (req, res) => {
  const wallet = callerWallet(req as AuthenticatedRequest, res);
  if (!wallet) return;
  try {
    await clearApplicationProgress(wallet);
    return res.status(204).end();
  } catch (err) {
    logger.error("Clear application progress error", { err });
    return res.status(500).json({ error: "progress_clear_failed" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/loan/queue-metrics  (issue #1107)
// Admin-only counts for the review pipeline. Withdrawn applications are
// reported separately and never counted in the active queue.
// ---------------------------------------------------------------------------
loanRouter.get("/queue-metrics", async (req, res) => {
  if (!isAdminRequest(req as AuthenticatedRequest)) {
    return res.status(403).json({ error: "forbidden", message: "Admin access required" });
  }
  try {
    return res.json(await getReviewQueueMetrics());
  } catch (err) {
    logger.error("Queue metrics error", { err });
    return res.status(500).json({ error: "queue_metrics_failed" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/loan/pending
// ---------------------------------------------------------------------------
loanRouter.get("/pending", async (req, res) => {
  const pending = await getPendingApplications();
  return res.json(pending);
});

// ---------------------------------------------------------------------------
// POST /api/loan/:id/approve
loanRouter.post("/:id/approve", idempotencyMiddleware, async (req, res) => {
  const id = String(req.params?.id ?? "");
  // Issue #760: approval is operator-only — even the owning borrower is rejected.
  const app = await requireLoanAdmin(req as AuthenticatedRequest, res, id);
  if (!app) return;

  // Optimistic lock (issue #846): echo back the version that was reviewed.
  // Checked before the state machine so a stale decision reads as a 409 with
  // the current state rather than a misleading 400 about the old status.
  const expectedVersion = parseExpectedVersion(req.body?.expectedVersion);
  if (expectedVersion === null) return missingExpectedVersionResponse(res);
  if (app.version !== expectedVersion) return versionConflictResponse(res, expectedVersion, app);

  if (app.status !== "Pending") {
    return res.status(400).json({
      error: "invalid_state",
      message: "Application must be Pending to approve",
    });
  }

  // Block approval when a guarantor address is present but not accepted
  if (app.guarantorAddress && app.guarantorStatus !== "Accepted") {
    return res.status(400).json({
      error: "guarantor_not_accepted",
      message:
        "This loan has a guarantor whose authorization is missing or invalid. " +
        "Guarantor must provide a valid signature before the loan can be approved.",
    });
  }

  try {
    const approved = await updateApplication(
      id,
      { status: "Approved" },
      { expectedVersion }
    );

    // simulate request_loan + approve_loan
    logger.info(`Simulating on-chain request_loan for application ${id}`);
    // After simulation, proceed to Disbursing
    const disbursing = updateApplication(id, { status: "Disbursing" });

    const email = req.body.email || `${app.borrowerAddress}@example.com`;
    const webhookUrl =
      req.body.webhookUrl || "https://partner-platform.com/webhooks";

    if (approved) {
      // The offering has just opened for investment: tell investors watching
      // it (issue #799). Best-effort and never throws — must not fail approval.
      void notifyWatchersOfOpenedOffering(id);

      await queueNotification(
        email,
        "EMAIL",
        JSON.stringify({
          template: "loan_status_update",
          loanId: id,
          status: "Approved",
        })
      );

      await queueNotification(
        webhookUrl,
        "WEBHOOK",
        JSON.stringify({
          event: "loan.milestone_approved",
          loanId: id,
          borrowerAddress: approved.borrowerAddress,
          status: "Approved",
          timestamp: Date.now(),
        })
      );
    }

    return res.json(disbursing);
  } catch (err) {
    // Optimistic lock lost between this request's read and its write
    // (issue #846) — return the record as it stands now.
    if (err instanceof StaleVersionError) {
      return versionConflictResponse(res, err.expectedVersion, err.current);
    }
    logger.error("Approve error", { err });
    return res.status(500).json({ error: "approve_failed" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/loan/:id/reject
// ---------------------------------------------------------------------------
loanRouter.post("/:id/reject", async (req, res) => {
  const id = String(req.params?.id ?? "");
  const { reason, reasonCode, reasonNote } = req.body ?? {};
  // Issue #760: rejection is operator-only — even the owning borrower is rejected.
  const app = await requireLoanAdmin(req as AuthenticatedRequest, res, id);
  if (!app) return;

  // Optimistic lock (issue #846) — see POST /:id/approve for rationale.
  const expectedVersion = parseExpectedVersion(req.body?.expectedVersion);
  if (expectedVersion === null) return missingExpectedVersionResponse(res);
  if (app.version !== expectedVersion) return versionConflictResponse(res, expectedVersion, app);

  // Issue #1102: a manual status change must say why, from the fixed list.
  const parsedReason = parseManualStatusChangeReason(reasonCode, reasonNote ?? reason);
  if (!parsedReason.ok) {
    return res.status(400).json({ error: parsedReason.error, message: parsedReason.message, field: "reasonCode" });
  }

  if (app.status !== "Pending") {
    return res.status(400).json({
      error: "invalid_state",
      message: "Application must be Pending to reject",
    });
  }

  try {
    const updated = await updateApplication(
      id,
      {
        status: "Rejected",
        reason: describeManualStatusChangeReason(parsedReason.reason),
      },
      {
        expectedVersion,
        manualStatusChange: {
          reason: parsedReason.reason,
          actorAddress: (req as AuthenticatedRequest).user?.walletAddress,
          ipAddress: req.ip,
        },
      }
    );
    return res.json(updated);
  } catch (err) {
    if (err instanceof StaleVersionError) {
      return versionConflictResponse(res, err.expectedVersion, err.current);
    }
    logger.error("Reject error", { err });
    return res.status(500).json({ error: "reject_failed" });
  }
});

// POST /api/loan/:id/resume
// Resumes a Draft application flagged as stale, resetting its inactivity clock.
loanRouter.post("/:id/resume", async (req, res) => {
  const id = String(req.params?.id ?? "");
  // Issue #760: only the owning borrower (or admin) may resume this draft.
  const owned = await requireLoanOwnership(req as AuthenticatedRequest, res, id);
  if (!owned) return;
  const resumed = await resumeDraftApplication(id);
  if (!resumed) return res.status(404).json({ error: "not_found_or_not_draft" });
  return res.json(resumed);
});

// POST /api/loan/:id/discard
// Lets an applicant explicitly discard a Draft application before it would otherwise expire.
loanRouter.post("/:id/discard", async (req, res) => {
  const id = String(req.params?.id ?? "");
  // Issue #760: only the owning borrower (or admin) may discard this draft.
  const owned = await requireLoanOwnership(req as AuthenticatedRequest, res, id);
  if (!owned) return;
  const discarded = await discardDraftApplication(id);
  if (!discarded) return res.status(404).json({ error: "not_found_or_not_draft" });
  return res.json(discarded);
});

// POST /api/loan/:id/withdraw  (issue #1107)
// Lets the applicant formally withdraw their own Pending application, with an
// optional reason. The record is kept for history but leaves the review queue.
// Withdrawing twice, or after a final decision, is a 409.
const WITHDRAWAL_FAILURE_MESSAGES = {
  already_withdrawn: "Application has already been withdrawn",
  final_decision: "Application already has a final decision and can no longer be withdrawn",
  not_withdrawable: "Only Pending applications can be withdrawn",
} as const;

loanRouter.post("/:id/withdraw", async (req, res) => {
  const id = String(req.params?.id ?? "");
  const owned = await requireLoanOwnership(req as AuthenticatedRequest, res, id);
  if (!owned) return;
  // Withdrawal is the applicant's own decision: the admin bypass in the
  // ownership gate does not extend to withdrawing on someone's behalf.
  if (owned.borrowerAddress.toLowerCase() !== (req as AuthenticatedRequest).user?.walletAddress.toLowerCase()) {
    return res.status(403).json({ error: "forbidden", message: "Only the applicant can withdraw this application." });
  }

  const rawReason = req.body?.reason;
  if (rawReason !== undefined && rawReason !== null && typeof rawReason !== "string") {
    return res.status(400).json({ error: "invalid_reason", field: "reason", message: "reason must be a string" });
  }
  const reason = typeof rawReason === "string" && rawReason.trim() ? rawReason.trim() : undefined;
  if (reason && reason.length > MAX_WITHDRAWAL_REASON_LENGTH) {
    return res.status(400).json({
      error: "invalid_reason",
      field: "reason",
      message: `reason must be at most ${MAX_WITHDRAWAL_REASON_LENGTH} characters`,
    });
  }

  try {
    const result = await withdrawApplication(id, reason);
    if (result.ok) return res.json(result.application);
    if (result.error === "not_found") return res.status(404).json({ error: "not_found" });
    return res.status(409).json({
      error: result.error,
      message: WITHDRAWAL_FAILURE_MESSAGES[result.error],
      current: result.current,
    });
  } catch (err) {
    logger.error("Withdraw error", { err });
    return res.status(500).json({ error: "withdraw_failed" });
  }
});

// GET /api/loan/:id
// Optional `?asOf=<ISO timestamp>` reconstructs the loan's historical state
// from the audit trail as it stood at that instant. Without `asOf`, the
// current record is returned unchanged.
loanRouter.get("/:id", async (req, res) => {
  const id = String(req.params?.id ?? "");
  const asOfRaw = req.query.asOf;

  // Issue #760: loan reads (current and historical) are owner-or-admin only.
  const owned = await requireLoanOwnership(req as AuthenticatedRequest, res, id);
  if (!owned) return;

  if (asOfRaw !== undefined) {
    if (typeof asOfRaw !== "string") {
      return res.status(400).json({ error: "invalid_asof", field: "asOf", message: "asOf must be a single ISO timestamp" });
    }
    const asOf = new Date(asOfRaw);
    if (Number.isNaN(asOf.getTime())) {
      return res.status(400).json({ error: "invalid_asof", field: "asOf", message: "asOf must be a valid ISO timestamp" });
    }

    const current = owned;

    const historical = await reconstructLoanApplicationAt(id, asOf, {
      // Loans created before the audit trail carried a creation snapshot fall
      // back to their current identity fields as the replay seed.
      fallbackSeed: {
        borrowerAddress: current.borrowerAddress,
        amount: current.amount,
        status: current.status,
        reason: current.reason,
      },
    });
    if (!historical) {
      return res.status(404).json({ error: "not_found_asof", message: "Loan did not exist at the requested timestamp" });
    }
    return res.json({ ...historical, asOf: asOf.toISOString() });
  }

  return res.json(owned);
});

// ---------------------------------------------------------------------------
// GET /api/loan/:id/activity
//
// One chronological feed of a loan's whole history: on-chain payments, status
// changes, KYC document uploads and operator actions. Scoped exactly like
// GET /:id (owner-or-admin). Paginated with the same keyset convention as
// /api/audit-logs; because events come from several tables the cursor is an
// opaque token rather than a plain row id.
// ---------------------------------------------------------------------------
loanRouter.get("/:id/activity", async (req, res) => {
  const id = String(req.params?.id ?? "");

  // Issue #760: activity reads are owner-or-admin only, matching GET /:id.
  const owned = await requireLoanOwnership(req as AuthenticatedRequest, res, id);
  if (!owned) return;

  const limitRaw = req.query.limit;
  const limit = typeof limitRaw === "string" && limitRaw ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    return res.status(400).json({
      error: "invalid_limit",
      field: "limit",
      message: "limit must be a positive integer",
    });
  }

  const cursor =
    typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : undefined;

  try {
    const timeline = await getLoanActivityTimeline(
      { id: owned.id, borrowerAddress: owned.borrowerAddress },
      { limit, cursor }
    );
    return res.json(timeline);
  } catch (error) {
    if (error instanceof InvalidActivityCursorError) {
      return res.status(400).json({ error: "invalid_cursor", field: "cursor", message: error.message });
    }
    logger.error("Loan activity timeline error", { error, loanId: id });
    return res.status(500).json({ error: "failed_to_load_activity" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/loan/:id/trigger-payment-due
// ---------------------------------------------------------------------------
loanRouter.post("/:id/trigger-payment-due", async (req, res) => {
  const id = String(req.params?.id ?? "");
  const { email, webhookUrl, amount, dueDate } = req.body ?? {};

  // Issue #760: only the owning borrower (or admin) may trigger notifications for this loan.
  const app = await requireLoanOwnership(req as AuthenticatedRequest, res, id);
  if (!app) return;

  const targetEmail = email || `${app.borrowerAddress}@example.com`;
  const targetWebhookUrl =
    webhookUrl || "https://partner-platform.com/webhooks";
  const targetAmount = amount || app.amount;
  const targetDueDate =
    dueDate ||
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const emailNotif = await queueNotification(
      targetEmail,
      "EMAIL",
      JSON.stringify({
        template: "repayment_reminder",
        amount: targetAmount,
        dueDate: targetDueDate,
      })
    );

    const webhookNotif = await queueNotification(
      targetWebhookUrl,
      "WEBHOOK",
      JSON.stringify({
        event: "loan.payment_due",
        loanId: id,
        borrowerAddress: app.borrowerAddress,
        amount: targetAmount,
        dueDate: targetDueDate,
        timestamp: Date.now(),
      })
    );

    return res.json({
      message: "Payment due notifications triggered and queued.",
      emailNotificationId: emailNotif.id,
      webhookNotificationId: webhookNotif.id,
    });
  } catch (error: any) {
    logger.error("Trigger payment due error", { error });
    return res
      .status(500)
      .json({ error: "failed_to_trigger_notifications", message: error.message });
  }
});

// POST /api/loan/check-duplicate
// Checks incoming KYC/applicant fields against existing applicants for potential duplicates.
loanRouter.post("/check-duplicate", async (req, res) => {
  try {
    const { fullName, address, idDocumentNumber, taxId, applicantId } = req.body ?? {};
    const source: ApplicantFields = { id: applicantId, fullName, address, idDocumentNumber, taxId };

    const allApplicants = await prisma.applicant.findMany({ where: { deletedAt: null } });
    const candidates: ApplicantFields[] = allApplicants.map((a: any) => ({
      id: a.id,
      fullName: a.taxId || undefined,
      taxId: a.taxId || undefined,
    }));

    const result = checkDuplicateApplicants(source, candidates);
    return res.json(result);
  } catch (error: any) {
    logger.error("Check duplicate error", { error });
    return res.status(500).json({ error: "failed_to_check_duplicates", message: error.message });
  }
});

// POST /api/loan/:id/review
// Logs manual reviewer decision (APPROVED or REJECTED) and updates loan application status.
loanRouter.post("/:id/review", async (req, res) => {
  try {
    const id = String(req.params?.id ?? "");
    const { reviewerId, decision, reason } = req.body ?? {};

    if (!reviewerId || !decision || (decision !== "APPROVED" && decision !== "REJECTED")) {
      return res.status(400).json({
        error: "invalid_request",
        message: "reviewerId and decision ('APPROVED' or 'REJECTED') are required.",
      });
    }

    // Issue #760: manual review decisions are operator-only.
    const app = await requireLoanAdmin(req as AuthenticatedRequest, res, id);
    if (!app) return;

    // Optimistic lock (issue #846): the reviewer must echo the version they
    // reviewed — checked before mutating anything so a stale decision is
    // rejected with the current state instead of overwriting a concurrent one.
    const expectedVersion = parseExpectedVersion(req.body?.expectedVersion);
    if (expectedVersion === null) return missingExpectedVersionResponse(res);
    if (app.version !== expectedVersion) return versionConflictResponse(res, expectedVersion, app);

    // Issue #1102: a manual status change must say why, from the fixed list.
    const parsedReason = parseManualStatusChangeReason(req.body?.reasonCode, req.body?.reasonNote ?? reason);
    if (!parsedReason.ok) {
      return res.status(400).json({ error: parsedReason.error, message: parsedReason.message, field: "reasonCode" });
    }
    const reasonText = describeManualStatusChangeReason(parsedReason.reason);

    const auditLog = logReviewerDecision(id, reviewerId, decision, reasonText);

    const newStatus = decision === "APPROVED" ? "Pending" : "Rejected";
    const updated = await updateApplication(
      id,
      { status: newStatus, reason: reasonText },
      {
        expectedVersion,
        manualStatusChange: {
          reason: parsedReason.reason,
          actorAddress: (req as AuthenticatedRequest).user?.walletAddress,
          ipAddress: req.ip,
        },
      }
    );

    return res.json({
      message: `Application reviewed successfully: set status to ${newStatus}`,
      application: updated,
      auditLog,
    });
  } catch (error: any) {
    if (error instanceof StaleVersionError) {
      return versionConflictResponse(res, error.expectedVersion, error.current);
    }
    logger.error("Manual review decision error", { error });
    return res.status(500).json({ error: "failed_to_process_review", message: error.message });
  }
});

// ── Collaborative Commenting ───────────────────────────────────────────────

function extractMentions(content: string): string[] {
  const mentionRegex = /@([A-Za-z0-9_.-]+)/g;
  const mentions: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(content)) !== null) {
    mentions.push(match[1]);
  }
  return [...new Set(mentions)];
}

/**
 * GET /api/loan/:id/comments
 * Returns threaded comments scoped to a loan application, ordered by createdAt.
 * Also serves as the poll endpoint for real-time display.
 */
loanRouter.get("/:id/comments", async (req, res) => {
  const id = String(req.params?.id ?? "");
  // Issue #760: comment threads are owner-or-admin only.
  const app = await requireLoanOwnership(req as AuthenticatedRequest, res, id);
  if (!app) return;

  const comments = await prisma.loanComment.findMany({
    where: { loanApplicationId: id },
    orderBy: { createdAt: "asc" },
  });

  // Build threaded tree: parentId -> replies
  const map = new Map<string, any>();
  const roots: any[] = [];
  for (const c of comments) {
    map.set(c.id, { ...c, replies: [] });
  }
  for (const c of comments) {
    const node = map.get(c.id);
    if (c.parentId && map.has(c.parentId)) {
      map.get(c.parentId).replies.push(node);
    } else {
      roots.push(node);
    }
  }

  return res.json({ loanApplicationId: id, comments: roots, total: comments.length });
});

/**
 * POST /api/loan/:id/comments
 * Adds a threaded comment, supports @-mentions triggering notifications,
 * and persists to audit trail.
 */
loanRouter.post("/:id/comments", async (req, res) => {
  const id = String(req.params?.id ?? "");
  const { authorAddress, author, content, parentId } = req.body ?? {};
  const authorAddr = authorAddress || author;

  if (!authorAddr || typeof authorAddr !== "string") {
    return res.status(400).json({ error: "invalid_request", message: "authorAddress is required" });
  }
  if (!content || typeof content !== "string" || content.trim().length === 0) {
    return res.status(400).json({ error: "invalid_request", message: "content is required" });
  }
  if (content.length > 5000) {
    return res.status(400).json({ error: "invalid_request", message: "content too long (max 5000)" });
  }

  // Issue #760: comment threads are owner-or-admin only; the caller must own the loan.
  const app = await requireLoanOwnership(req as AuthenticatedRequest, res, id);
  if (!app) return;

  if (parentId) {
    const parent = await prisma.loanComment.findUnique({ where: { id: parentId } });
    if (!parent || parent.loanApplicationId !== id) {
      return res.status(400).json({ error: "invalid_request", message: "parent comment not found for this application" });
    }
  }

  const mentions = extractMentions(content);

  try {
    const comment = await prisma.loanComment.create({
      data: {
        loanApplicationId: id,
        authorAddress: authorAddr,
        content: content.trim(),
        parentId: parentId || null,
        mentions,
      },
    });

    // Persist as part of audit trail
    try {
      await prisma.auditLog.create({
        data: {
          action: "loan_comment",
          actorAddress: authorAddr,
          metadata: {
            loanApplicationId: id,
            commentId: comment.id,
            parentId: parentId || null,
            mentions,
            contentPreview: content.slice(0, 200),
          },
        },
      });
    } catch (auditErr) {
      logger.warn("Failed to write loan_comment audit log", { err: auditErr });
    }

    // Notify mentioned reviewers - creates InAppNotification linking directly to thread
    for (const mentioned of mentions) {
      try {
        // mentions may be wallet address or username; store as walletAddress if matches G... else treat as identifier
        await prisma.inAppNotification.create({
          data: {
            walletAddress: mentioned,
            title: `You were mentioned in loan ${id}`,
            message: `${authorAddr} mentioned you: "${content.slice(0, 120)}"`,
            variant: "info",
            metadata: {
              loanApplicationId: id,
              commentId: comment.id,
              parentId: parentId || null,
              anchor: `comment-${comment.id}`,
              href: `/admin?loan=${id}#comment-${comment.id}`,
            },
          },
        });
      } catch (notifErr) {
        logger.warn("Failed to create mention notification", { mentioned, err: notifErr });
      }
    }

    return res.status(201).json(comment);
  } catch (err: any) {
    logger.error("Create comment error", { err });
    return res.status(500).json({ error: "failed_to_create_comment" });
  }
});
