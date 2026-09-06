import { Router, Request, Response } from "express";
import { prisma } from "../services/db.js";
import { sendWebhook } from "../services/webhook.js";
import { runEscrowReconciliation } from "../jobs/escrowReconciliation.js";
import logger from "../utils/logger.js";
import { requireAdmin, type AuthenticatedRequest } from "../middleware/auth.js";
import { bulkReviewApplications, type BulkReviewDecision } from "../services/loanStore.js";
import { promoteWaitlistBatch } from "../services/inviteCode.js";

export const adminRouter = Router();

/**
 * @openapi
 * /api/admin/loans/bulk-review:
 *   post:
 *     summary: Approve or reject multiple pending loan applications
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 */
adminRouter.post("/loans/bulk-review", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const body = req.body ?? {};
  const rawItems = Array.isArray(body.reviews)
    ? body.reviews
    : Array.isArray(body.applicationIds) && typeof body.decision === "string"
      ? body.applicationIds.map((applicationId: unknown) => ({ applicationId, decision: body.decision, reason: body.reason }))
      : null;

  if (!rawItems || rawItems.length === 0 || rawItems.length > 100) {
    return res.status(400).json({ error: "invalid_request", message: "reviews must contain between 1 and 100 applications" });
  }

  const items = rawItems.map((item: any) => ({
    applicationId: typeof item?.applicationId === "string" ? item.applicationId : item?.id,
    decision: item?.decision,
    reason: item?.reason,
  }));
  if (items.some((item: any) => !item.applicationId || !["approve", "reject"].includes(item.decision))) {
    return res.status(400).json({ error: "invalid_request", message: "Each review requires an applicationId and an approve or reject decision" });
  }

  const reviewerAddress = req.user?.walletAddress;
  if (!reviewerAddress) {
    return res.status(403).json({ error: "forbidden", message: "Reviewer identity is required" });
  }

  try {
    const review = await bulkReviewApplications(
      items as Array<{ applicationId: string; decision: BulkReviewDecision; reason?: string }>,
      reviewerAddress,
      req.ip,
    );
    return res.status(200).json({
      processed: review.results.length,
      failed: review.failures.length,
      results: review.results,
      failures: review.failures,
    });
  } catch (error) {
    logger.error("Bulk loan review error", { error });
    return res.status(500).json({ error: "bulk_review_failed" });
  }
});

// ── Auto-rejection rules (configurable without redeploy) ─────────────────

adminRouter.get("/auto-rejection-rules", requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const rules = await listAutoRejectionRules(true);
    return res.json(rules);
  } catch (error) {
    logger.error("List auto-rejection rules error", { error });
    return res.status(500).json({ error: "failed_to_list_rules" });
  }
});

adminRouter.post("/auto-rejection-rules", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { name, ruleType, config, active, priority } = req.body ?? {};
  if (!name || !ruleType || !config) {
    return res.status(400).json({
      error: "invalid_request",
      message: "name, ruleType, and config are required",
    });
  }

  try {
    const rule = await createAutoRejectionRule({
      name: String(name),
      ruleType,
      config,
      active,
      priority,
    });
    return res.status(201).json(rule);
  } catch (error) {
    logger.error("Create auto-rejection rule error", { error });
    return res.status(500).json({ error: "failed_to_create_rule" });
  }
});

adminRouter.patch("/auto-rejection-rules/:id", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { name, config, active, priority } = req.body ?? {};

  try {
    const rule = await updateAutoRejectionRule(id, {
      ...(name !== undefined ? { name: String(name) } : {}),
      ...(config !== undefined ? { config } : {}),
      ...(active !== undefined ? { active: Boolean(active) } : {}),
      ...(priority !== undefined ? { priority: Number(priority) } : {}),
    });
    return res.json(rule);
  } catch (error) {
    logger.error("Update auto-rejection rule error", { error });
    return res.status(404).json({ error: "rule_not_found" });
  }
});

// Trigger manual retry of a DLQ job
adminRouter.post("/webhooks/dlq/:id/retry", async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;

  try {
      const dlqRecord = await prisma.webhookDLQ.findUnique({ where: { id } });

    if (!dlqRecord) {
      res.status(404).json({ error: "DLQ record not found" });
      return;
    }

    const payload = typeof dlqRecord.payload === "string" 
      ? JSON.parse(dlqRecord.payload) 
      : dlqRecord.payload;

    const webhookResult = await sendWebhook(dlqRecord.url, payload);

    if (webhookResult.success) {
      // If success, remove from DLQ
      await prisma.webhookDLQ.delete({ where: { id } });
      res.json({ success: true, message: "Webhook retry succeeded and removed from DLQ" });
    } else {
      // If still fails, update DLQ record with new error/status
      await prisma.webhookDLQ.update({ where: { id }, data: { statusCode: webhookResult.status, responsePayload: webhookResult.responsePayload, error: webhookResult.error } });
      res.status(500).json({ 
        success: false, 
        error: "Webhook retry failed", 
        details: webhookResult 
      });
    }
  } catch (err: any) {
    logger.error(`[AdminRouter] Failed to retry DLQ ${id}`, { err });
    res.status(500).json({ error: "Internal server error during retry" });
  }
});

/**
 * @openapi
 * /api/admin/escrow/reconcile:
 *   post:
 *     summary: Trigger manual escrow balance reconciliation
 *     description: >-
 *       Ops-only. Fetches current on-chain USDC balances for all borrower
 *       accounts from Horizon, compares them against the Postgres cache, and
 *       overwrites any mismatched cached values with the on-chain truth.
 *       Also clears outstanding mismatch alerts once corrected.
 *     tags:
 *       - Admin
 *     responses:
 *       200:
 *         description: Reconciliation complete. Returns counts of scanned, mismatches, corrected, and errors.
 *       500:
 *         description: Reconciliation job threw an unexpected error.
 */
adminRouter.post("/escrow/reconcile", async (req: Request, res: Response) => {
  try {
    logger.info("[AdminRouter] Manual escrow reconciliation triggered", {
      ip: req.ip,
    });

    // autoCorrect=true: fix cached values and clear the alert
    const result = await runEscrowReconciliation(true);

    res.json({
      success: true,
      scanned: result.scanned,
      mismatches: result.mismatches.length,
      corrected: result.corrected,
      errors: result.errors,
      details: result.mismatches,
    });
  } catch (err: any) {
    logger.error("[AdminRouter] Escrow reconciliation failed", { err });
    res.status(500).json({ error: "Reconciliation job failed", message: err.message });
  }
});

/**
 * @openapi
 * /api/admin/waitlist/promote:
 *   post:
 *     summary: Generate and email invite codes to waitlisted users in batches
 *     description: >-
 *       Admin-only. Picks oldest pending waitlist entries, generates a unique
 *       invite code per user, updates entry to invited, and emails the code.
 *       Codes are single-use and validated at registration when gating is enabled.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               count:
 *                 type: integer
 *                 description: Number of waitlisted users to promote (1-100, default 10)
 *               limit:
 *                 type: integer
 *                 description: Alias for count
 *     responses:
 *       200:
 *         description: Batch promotion complete
 *       400:
 *         description: Invalid count
 */
adminRouter.post("/waitlist/promote", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const body = req.body ?? {};
  const rawCount = body.count ?? body.limit ?? body.batchSize ?? 10;
  const count = typeof rawCount === "string" ? parseInt(rawCount, 10) : Number(rawCount);
  if (!Number.isFinite(count) || count < 1 || count > 100) {
    return res.status(400).json({ error: "invalid_request", message: "count must be between 1 and 100" });
  }
  try {
    const results = await promoteWaitlistBatch(count);
    return res.json({ promoted: results.length, results });
  } catch (err) {
    logger.error("[AdminRouter] waitlist promote failed", { err });
    return res.status(500).json({ error: "waitlist_promote_failed" });
  }
});
