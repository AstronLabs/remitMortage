import { Router } from "express";
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
  escrowTargetMetForAmount,
} from "../services/loanStore.js";
import {
  verifyStellarGuarantorSignature,
  buildGuarantorCommitment,
} from "../services/guarantor.js";
import { queueNotification } from "../services/notification.js";
import { hasExpiredKycDocuments } from "../jobs/kycExpiryReminder.js";
import { prisma } from "../services/db.js";
import { reconstructLoanApplicationAt } from "../services/loanHistory.js";

export const loanRouter = Router();

import {
  checkDuplicateApplicants,
  logReviewerDecision,
  ApplicantFields,
} from "../utils/fuzzyMatch.js";

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

    const app = await createApplication(borrowerAddress, String(amount));
    if (dupStatus === "MANUAL_REVIEW") {
      await updateApplication(app.id, { status: "MANUAL_REVIEW" });
      app.status = "MANUAL_REVIEW";
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
);

// ---------------------------------------------------------------------------
// GET /api/loan/borrower/:address
// ---------------------------------------------------------------------------
loanRouter.get("/borrower/:address", async (req, res) => {
  const { address } = req.params ?? {};
  try {
    StrKey.decodeEd25519PublicKey(address);
  } catch {
    return res
      .status(400)
      .json({ error: "invalid_address", field: "address", message: "Invalid Stellar G-address" });
  }
  const apps = await getApplicationsByBorrower(address);
  return res.json(apps);
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
  const { id } = req.params;
  const app = await getApplication(id);
  if (!app) return res.status(404).json({ error: "not_found" });

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
    const approved = await updateApplication(id, { status: "Approved" });

    // simulate request_loan + approve_loan
    logger.info(`Simulating on-chain request_loan for application ${id}`);
    // After simulation, proceed to Disbursing
    const disbursing = updateApplication(id, { status: "Disbursing" });

    const email = req.body.email || `${app.borrowerAddress}@example.com`;
    const webhookUrl =
      req.body.webhookUrl || "https://partner-platform.com/webhooks";

    if (approved) {
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
    logger.error("Approve error", { err });
    return res.status(500).json({ error: "approve_failed" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/loan/:id/reject
// ---------------------------------------------------------------------------
loanRouter.post("/:id/reject", async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body ?? {};
  const app = await getApplication(id);
  if (!app) return res.status(404).json({ error: "not_found" });

  if (app.status !== "Pending") {
    return res.status(400).json({
      error: "invalid_state",
      message: "Application must be Pending to reject",
    });
  }

  const updated = await updateApplication(id, {
    status: "Rejected",
    reason: reason ?? "No reason provided",
  });
  return res.json(updated);
});

// POST /api/loan/:id/resume
// Resumes a Draft application flagged as stale, resetting its inactivity clock.
loanRouter.post("/:id/resume", async (req, res) => {
  const { id } = req.params;
  const resumed = await resumeDraftApplication(id);
  if (!resumed) return res.status(404).json({ error: "not_found_or_not_draft" });
  return res.json(resumed);
});

// POST /api/loan/:id/discard
// Lets an applicant explicitly discard a Draft application before it would otherwise expire.
loanRouter.post("/:id/discard", async (req, res) => {
  const { id } = req.params;
  const discarded = await discardDraftApplication(id);
  if (!discarded) return res.status(404).json({ error: "not_found_or_not_draft" });
  return res.json(discarded);
});

// GET /api/loan/:id
// Optional `?asOf=<ISO timestamp>` reconstructs the loan's historical state
// from the audit trail as it stood at that instant. Without `asOf`, the
// current record is returned unchanged.
loanRouter.get("/:id", async (req, res) => {
  const { id } = req.params;
  const asOfRaw = req.query.asOf;

  if (asOfRaw !== undefined) {
    if (typeof asOfRaw !== "string") {
      return res.status(400).json({ error: "invalid_asof", field: "asOf", message: "asOf must be a single ISO timestamp" });
    }
    const asOf = new Date(asOfRaw);
    if (Number.isNaN(asOf.getTime())) {
      return res.status(400).json({ error: "invalid_asof", field: "asOf", message: "asOf must be a valid ISO timestamp" });
    }

    const current = await getApplication(id);
    if (!current) return res.status(404).json({ error: "not_found" });

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

  const app = await getApplication(id);
  if (!app) return res.status(404).json({ error: "not_found" });
  return res.json(app);
});

// ---------------------------------------------------------------------------
// POST /api/loan/:id/trigger-payment-due
// ---------------------------------------------------------------------------
loanRouter.post("/:id/trigger-payment-due", async (req, res) => {
  const { id } = req.params;
  const { email, webhookUrl, amount, dueDate } = req.body ?? {};

  const app = await getApplication(id);
  if (!app) return res.status(404).json({ error: "not_found" });

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
    const { id } = req.params;
    const { reviewerId, decision, reason } = req.body ?? {};

    if (!reviewerId || !decision || (decision !== "APPROVED" && decision !== "REJECTED")) {
      return res.status(400).json({
        error: "invalid_request",
        message: "reviewerId and decision ('APPROVED' or 'REJECTED') are required.",
      });
    }

    const app = await getApplication(id);
    if (!app) return res.status(404).json({ error: "not_found" });

    const auditLog = logReviewerDecision(id, reviewerId, decision, reason);

    const newStatus = decision === "APPROVED" ? "Pending" : "Rejected";
    const updated = await updateApplication(id, {
      status: newStatus,
      reason: reason || (decision === "APPROVED" ? "Manual review approved" : "Manual review rejected duplicate"),
    });

    return res.json({
      message: `Application reviewed successfully: set status to ${newStatus}`,
      application: updated,
      auditLog,
    });
  } catch (error: any) {
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
  const { id } = req.params;
  const app = await getApplication(id);
  if (!app) return res.status(404).json({ error: "not_found" });

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
  const { id } = req.params;
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

  const app = await getApplication(id);
  if (!app) return res.status(404).json({ error: "not_found" });

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

