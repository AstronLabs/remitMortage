// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Late-fee hardship waiver HTTP surface (issue #749).
 *
 * Borrower endpoints live under /api/loan (ownership-checked):
 *   POST /api/loan/:id/waiver-requests  — file a hardship request
 *   GET  /api/loan/:id/waiver-requests  — track request status
 *
 * Admin endpoints live under /api/admin (operator-only):
 *   GET  /api/admin/waivers/queue               — PENDING review queue + criteria
 *   POST /api/admin/waivers/:requestId/decision — approve / deny / partial
 */

import { Router, Response } from "express";
import { requireAdmin, type AuthenticatedRequest } from "../middleware/auth.js";
import {
  requireLoanOwnership,
  requireBorrowerAddressOwnership,
} from "../security/requireResourceOwnership.js";
import {
  createWaiverRequest,
  listWaiverRequestsForLoan,
  listPendingWaiverQueue,
  decideWaiverRequest,
  getWaiverApprovalCriteria,
  HARDSHIP_REASONS,
  FeeWaiverError,
} from "../services/feeWaiver.js";
import logger from "../utils/logger.js";

export const feeWaiverLoanRouter = Router({ mergeParams: true });
export const feeWaiverAdminRouter = Router();

// ── Borrower: file a hardship waiver request ──────────────────────────
feeWaiverLoanRouter.post("/:id/waiver-requests", async (req: AuthenticatedRequest, res: Response) => {
  const loanId = String(req.params?.id ?? "");
  const owned = await requireLoanOwnership(req, res, loanId);
  if (!owned) return;
  const borrowerAddress = req.user?.walletAddress ?? (owned as any).borrowerAddress;
  try {
    const created = await createWaiverRequest({
      loanId,
      borrowerAddress,
      hardshipReason: (req.body ?? {}).hardshipReason,
      context: (req.body ?? {}).context,
      ipAddress: req.ip,
    });
    return res.status(201).json(created);
  } catch (err) {
    if (err instanceof FeeWaiverError) {
      return res.status(err.httpStatus).json({ error: err.code, message: err.message });
    }
    logger.error("Fee waiver request failed", { err });
    return res.status(500).json({ error: "waiver_request_failed" });
  }
});

// ── Borrower: track waiver request status ─────────────────────────────
feeWaiverLoanRouter.get("/:id/waiver-requests", async (req: AuthenticatedRequest, res: Response) => {
  const loanId = String(req.params?.id ?? "");
  const owned = await requireLoanOwnership(req, res, loanId);
  if (!owned) return;
  try {
    const requests = await listWaiverRequestsForLoan(loanId);
    return res.json({ loanId, requests, hardshipReasons: [...HARDSHIP_REASONS] });
  } catch (err) {
    logger.error("Fee waiver list failed", { err });
    return res.status(500).json({ error: "failed_to_list_waivers" });
  }
});

// Borrower address-scoped listing (alternative tracking view).
export const feeWaiverBorrowerRouter = Router();
feeWaiverBorrowerRouter.get("/:address/waiver-requests", async (req: AuthenticatedRequest, res: Response) => {
  const address = String(req.params?.address ?? "");
  if (!requireBorrowerAddressOwnership(req, res, address)) return;
  try {
    const { prisma } = await import("../services/db.js");
    const requests = await (prisma as any).lateFeeWaiverRequest.findMany({
      where: { borrowerAddress: address },
      orderBy: { createdAt: "desc" },
    });
    return res.json({ borrowerAddress: address, requests });
  } catch (err) {
    logger.error("Fee waiver borrower list failed", { err });
    return res.status(500).json({ error: "failed_to_list_waivers" });
  }
});

// ── Admin: review queue with documented criteria ──────────────────────
feeWaiverAdminRouter.get("/waivers/queue", requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const queue = await listPendingWaiverQueue();
    return res.json({ criteria: getWaiverApprovalCriteria(), queue });
  } catch (err) {
    logger.error("Fee waiver queue failed", { err });
    return res.status(500).json({ error: "failed_to_load_waiver_queue" });
  }
});

// ── Admin: approve / deny / partial-waiver ────────────────────────────
feeWaiverAdminRouter.post("/waivers/:requestId/decision", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const requestId = String(req.params?.requestId ?? "");
  const body = req.body ?? {};
  try {
    const result = await decideWaiverRequest({
      requestId,
      decision: body.decision,
      waivedAmount: body.waivedAmount,
      decisionReason: body.decisionReason,
      decidedBy: req.user?.walletAddress ?? "admin-api-key",
      ipAddress: req.ip,
    });
    return res.json(result);
  } catch (err) {
    if (err instanceof FeeWaiverError) {
      return res.status(err.httpStatus).json({ error: err.code, message: err.message });
    }
    logger.error("Fee waiver decision failed", { err });
    return res.status(500).json({ error: "waiver_decision_failed" });
  }
});
