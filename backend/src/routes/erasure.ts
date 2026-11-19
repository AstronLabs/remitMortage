// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router } from "express";
import { authMiddleware, requireAdmin, AuthenticatedRequest } from "../middleware/auth.js";
import {
  submitErasureRequest,
  attachLegalHold,
  liftLegalHold,
  decideErasureRequest,
  executeErasure,
  getErasureRequest,
  createLegalHold,
  LegalHoldReason,
} from "../services/erasureWorkflow.js";

export const erasureRouter = Router();

/**
 * POST /api/gdpr/erasure-requests
 * Authenticated user submits a GDPR right-to-erasure request for their own account.
 */
erasureRouter.post(
  "/",
  authMiddleware,
  async (req: AuthenticatedRequest, res) => {
    const walletAddress = req.user?.walletAddress;
    if (!walletAddress) {
      return res.status(401).json({ error: "Unauthenticated" });
    }

    try {
      const request = await submitErasureRequest(walletAddress, walletAddress);
      return res.status(201).json(request);
    } catch (err) {
      return res.status(500).json({ error: "Failed to submit erasure request" });
    }
  }
);

/**
 * GET /api/gdpr/erasure-requests/:requestId
 * Retrieve the current state of an erasure request.
 * The subject may view their own; admins may view any.
 */
erasureRouter.get(
  "/:requestId",
  authMiddleware,
  async (req: AuthenticatedRequest, res) => {
    const requestId = String(req.params.requestId);
    const request = getErasureRequest(requestId);

    if (!request) {
      return res.status(404).json({ error: "Erasure request not found" });
    }

    const isAdmin = (req as any).isAdmin === true;
    if (!isAdmin && request.walletAddress !== req.user?.walletAddress) {
      return res.status(403).json({ error: "Forbidden" });
    }

    return res.json(request);
  }
);

/**
 * POST /api/gdpr/erasure-requests/:requestId/holds
 * Admin attaches a new legal hold, blocking erasure.
 */
erasureRouter.post(
  "/:requestId/holds",
  authMiddleware,
  requireAdmin,
  (req: AuthenticatedRequest, res) => {
    const requestId = String(req.params.requestId);
    const { reason, expiresAt } = req.body as {
      reason?: LegalHoldReason;
      expiresAt?: string;
    };

    if (!reason) {
      return res.status(400).json({ error: "'reason' is required" });
    }

    const VALID_REASONS: LegalHoldReason[] = [
      "active_loan",
      "regulatory_investigation",
      "tax_compliance",
      "fraud_review",
      "other",
    ];
    if (!VALID_REASONS.includes(reason)) {
      return res.status(400).json({ error: `Unknown hold reason: ${reason}` });
    }

    try {
      const hold = createLegalHold(
        reason,
        req.user!.walletAddress,
        expiresAt ? new Date(expiresAt) : undefined
      );
      const updated = attachLegalHold(requestId, hold, req.user!.walletAddress);
      return res.status(201).json({ hold, request: updated });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (message.includes("not found")) {
        return res.status(404).json({ error: message });
      }
      return res.status(500).json({ error: message });
    }
  }
);

/**
 * DELETE /api/gdpr/erasure-requests/:requestId/holds/:holdId
 * Admin lifts a previously-attached legal hold.
 */
erasureRouter.delete(
  "/:requestId/holds/:holdId",
  authMiddleware,
  requireAdmin,
  (req: AuthenticatedRequest, res) => {
    const requestId = String(req.params.requestId);
    const holdId = String(req.params.holdId);

    try {
      const updated = liftLegalHold(requestId, holdId, req.user!.walletAddress);
      return res.json(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (message.includes("not found")) {
        return res.status(404).json({ error: message });
      }
      return res.status(500).json({ error: message });
    }
  }
);

/**
 * POST /api/gdpr/erasure-requests/:requestId/decision
 * Admin approves or rejects an erasure request.
 */
erasureRouter.post(
  "/:requestId/decision",
  authMiddleware,
  requireAdmin,
  (req: AuthenticatedRequest, res) => {
    const requestId = String(req.params.requestId);
    const { decision, reason } = req.body as {
      decision?: "approve" | "reject";
      reason?: string;
    };

    if (!decision || !["approve", "reject"].includes(decision)) {
      return res.status(400).json({ error: "'decision' must be 'approve' or 'reject'" });
    }
    if (!reason) {
      return res.status(400).json({ error: "'reason' is required" });
    }

    try {
      const updated = decideErasureRequest({
        requestId,
        decidedBy: req.user!.walletAddress,
        decision,
        reason,
      });
      return res.json(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (message.includes("not found")) return res.status(404).json({ error: message });
      if (message.includes("active legal hold")) return res.status(409).json({ error: message });
      return res.status(500).json({ error: message });
    }
  }
);

/**
 * POST /api/gdpr/erasure-requests/:requestId/execute
 * Admin triggers the actual PII scrub for an approved request.
 */
erasureRouter.post(
  "/:requestId/execute",
  authMiddleware,
  requireAdmin,
  async (req: AuthenticatedRequest, res) => {
    const requestId = String(req.params.requestId);

    try {
      const updated = await executeErasure(requestId, req.user!.walletAddress);
      return res.json(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (message.includes("not found")) return res.status(404).json({ error: message });
      if (message.includes("status")) return res.status(409).json({ error: message });
      return res.status(500).json({ error: message });
    }
  }
);
