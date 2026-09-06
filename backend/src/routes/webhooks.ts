/**
 * Webhook Subscription Management API
 *
 * All routes are admin-gated (requireAdmin) except the signature-verification
 * helper which is intentionally public so receivers can test their integration.
 *
 * Base path: /api/webhooks  (mounted in index.ts)
 *
 * POST   /api/webhooks/subscriptions            — create subscription
 * GET    /api/webhooks/subscriptions            — list subscriptions
 * GET    /api/webhooks/subscriptions/:id        — get one subscription
 * PATCH  /api/webhooks/subscriptions/:id/status — pause / revoke / reactivate
 * POST   /api/webhooks/subscriptions/:id/rotate — rotate HMAC secret
 * GET    /api/webhooks/subscriptions/:id/deliveries — delivery history
 * POST   /api/webhooks/deliveries/:deliveryId/replay — manual replay
 * POST   /api/webhooks/verify                   — test signature verification (public)
 */

import { Router, Request, Response } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { prisma } from "../services/db.js";
import {
  createSubscription,
  listSubscriptions,
  getSubscription,
  updateSubscriptionStatus,
  rotateSecret,
  replayDelivery,
  verifySignature,
  verifySubscriptionSignature,
  type EventTopic,
} from "../services/webhook.js";

export const webhooksRouter = Router();

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

const VALID_TOPICS = new Set([
  "deposit",
  "withdraw",
  "release",
  "disburse",
  "repay",
  "all",
]);
const VALID_STATUSES = new Set(["active", "paused", "revoked"]);

function isValidUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// POST /api/webhooks/subscriptions
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/webhooks/subscriptions:
 *   post:
 *     summary: Create a webhook subscription
 *     description: >
 *       Registers a new endpoint to receive signed webhook events.
 *       The response includes the plaintext HMAC secret — it is shown **once**
 *       and cannot be retrieved again. Store it securely.
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [label, url]
 *             properties:
 *               label:       { type: string, example: "Acme Underwriter" }
 *               url:         { type: string, format: uri, example: "https://partner.example.com/hooks" }
 *               topics:      { type: array, items: { type: string }, example: ["deposit","disburse"] }
 *               ownerAddress:{ type: string, example: "GABC..." }
 *     responses:
 *       201:
 *         description: Subscription created — secret shown once
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 */
webhooksRouter.post(
  "/subscriptions",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const { label, url, topics, ownerAddress } = req.body ?? {};

    if (!label || typeof label !== "string" || label.trim() === "") {
      res.status(400).json({ error: "validation", message: "`label` is required" });
      return;
    }

    if (!url || typeof url !== "string" || !isValidUrl(url)) {
      res.status(400).json({ error: "validation", message: "`url` must be a valid HTTP/S URL" });
      return;
    }

    if (topics !== undefined) {
      if (!Array.isArray(topics) || topics.some((t) => !VALID_TOPICS.has(t))) {
        res.status(400).json({
          error: "validation",
          message: `\`topics\` must be an array of: ${[...VALID_TOPICS].join(", ")}`,
        });
        return;
      }
    }

    try {
      const { subscription, plaintextSecret } = await createSubscription({
        label: label.trim(),
        url: url.trim(),
        topics: topics as EventTopic[] | undefined,
        ownerAddress: ownerAddress ?? undefined,
      });

      res.status(201).json({
        subscription,
        // Shown once — the caller must deliver this to their receiver securely.
        secret: plaintextSecret,
        _warning:
          "Store the secret immediately. It will not be shown again.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create subscription";
      res.status(500).json({ error: "server_error", message });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/webhooks/subscriptions
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/webhooks/subscriptions:
 *   get:
 *     summary: List webhook subscriptions
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: ownerAddress
 *         schema: { type: string }
 *         description: Filter by owner wallet address
 *     responses:
 *       200:
 *         description: Array of subscription objects (secrets omitted)
 */
webhooksRouter.get(
  "/subscriptions",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const ownerAddress = req.query.ownerAddress as string | undefined;
      const subscriptions = await listSubscriptions(ownerAddress);
      res.json({ subscriptions });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to list subscriptions";
      res.status(500).json({ error: "server_error", message });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/webhooks/subscriptions/:id
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/webhooks/subscriptions/{id}:
 *   get:
 *     summary: Get a single webhook subscription
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Subscription object (secret omitted)
 *       404:
 *         description: Not found
 */
webhooksRouter.get(
  "/subscriptions/:id",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const sub = await getSubscription(id);
      if (!sub) {
        res.status(404).json({ error: "not_found", message: "Subscription not found" });
        return;
      }
      res.json({ subscription: sub });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch subscription";
      res.status(500).json({ error: "server_error", message });
    }
  }
);

// ---------------------------------------------------------------------------
// PATCH /api/webhooks/subscriptions/:id/status
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/webhooks/subscriptions/{id}/status:
 *   patch:
 *     summary: Update subscription status
 *     description: Pause, revoke, or reactivate a subscription.
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [active, paused, revoked] }
 *     responses:
 *       200:
 *         description: Updated subscription
 *       400:
 *         description: Invalid status value
 *       404:
 *         description: Not found
 */
webhooksRouter.patch(
  "/subscriptions/:id/status",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const { status } = req.body ?? {};

    if (!status || !VALID_STATUSES.has(status)) {
      res.status(400).json({
        error: "validation",
        message: `\`status\` must be one of: ${[...VALID_STATUSES].join(", ")}`,
      });
      return;
    }

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const existing = await getSubscription(id);
      if (!existing) {
        res.status(404).json({ error: "not_found", message: "Subscription not found" });
        return;
      }

      const updated = await updateSubscriptionStatus(id, status as "active" | "paused" | "revoked");
      res.json({ subscription: updated });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update status";
      res.status(500).json({ error: "server_error", message });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/webhooks/subscriptions/:id/rotate
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/webhooks/subscriptions/{id}/rotate:
 *   post:
 *     summary: Rotate the HMAC secret for a subscription
 *     description: >
 *       Generates a new 32-byte random secret and promotes it to primary.
 *       The prior secret is kept as a secondary key for a 7-day grace period
 *       so deliveries verified against it don't break mid-rotation, then it
 *       is pruned automatically. The response includes the new plaintext
 *       secret **once** — update your receiver promptly.
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: New secret (shown once)
 *       404:
 *         description: Not found
 */
webhooksRouter.post(
  "/subscriptions/:id/rotate",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const existing = await getSubscription(id);
      if (!existing) {
        res.status(404).json({ error: "not_found", message: "Subscription not found" });
        return;
      }

      const { plaintextSecret } = await rotateSecret(id);
      res.json({
        secret: plaintextSecret,
        _warning:
          "Update your receiver with the new secret. The previous secret keeps validating for a 7-day grace period, then is pruned.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to rotate secret";
      res.status(500).json({ error: "server_error", message });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/webhooks/subscriptions/:id/deliveries
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/webhooks/subscriptions/{id}/deliveries:
 *   get:
 *     summary: List delivery attempts for a subscription
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *       - in: query
 *         name: success
 *         schema: { type: boolean }
 *         description: Filter by outcome (true = successful only, false = failed only)
 *     responses:
 *       200:
 *         description: Paginated delivery history
 *       404:
 *         description: Subscription not found
 */
webhooksRouter.get(
  "/subscriptions/:id/deliveries",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const existing = await getSubscription(id);
      if (!existing) {
        res.status(404).json({ error: "not_found", message: "Subscription not found" });
        return;
      }

      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const skip = (page - 1) * limit;

      const subscriptionId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const where: Record<string, unknown> = { subscriptionId };
      if (req.query.success !== undefined) {
        where.success = req.query.success === "true";
      }

      const [deliveries, total] = await Promise.all([
        prisma.webhookDelivery.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip,
          take: limit,
          // Omit the raw payload from list view to keep responses compact.
          select: {
            id: true,
            topic: true,
            statusCode: true,
            responseBody: true,
            error: true,
            success: true,
            attempt: true,
            nextRetryAt: true,
            createdAt: true,
          },
        }),
        prisma.webhookDelivery.count({ where }),
      ]);

      res.json({
        deliveries,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNextPage: page < Math.ceil(total / limit),
          hasPrevPage: page > 1,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to list deliveries";
      res.status(500).json({ error: "server_error", message });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/webhooks/deliveries/:deliveryId/replay
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/webhooks/deliveries/{deliveryId}/replay:
 *   post:
 *     summary: Manually replay a delivery attempt
 *     description: >
 *       Re-sends the original payload to the subscription's URL with a fresh
 *       timestamp and signature. Creates a new WebhookDelivery row.
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: deliveryId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Replay result
 *       404:
 *         description: Original delivery not found
 *       400:
 *         description: Subscription is revoked
 */
webhooksRouter.post(
  "/deliveries/:deliveryId/replay",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const rawDeliveryId = req.params.deliveryId;
      const deliveryId = Array.isArray(rawDeliveryId) ? rawDeliveryId[0] : rawDeliveryId;
      const result = await replayDelivery(deliveryId);
      res.json({ result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Replay failed";
      const status = message.includes("not found")
        ? 404
        : message.includes("revoked")
          ? 400
          : 500;
      res.status(status).json({ error: "replay_error", message });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/webhooks/verify  (public — no auth required)
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/webhooks/verify:
 *   post:
 *     summary: Verify a webhook signature
 *     description: >
 *       Public helper endpoint. Receivers can POST their raw request body,
 *       timestamp, and signature here to confirm the signature is valid.
 *       Provide either `secret` directly, or `subscriptionId` to verify
 *       against that subscription's stored keys — which checks the current
 *       primary key *and*, during the post-rotation grace period, the
 *       previous key, so verification doesn't break mid-rotation.
 *       This endpoint does NOT require authentication.
 *     tags: [Webhooks]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [timestamp, rawBody, signature]
 *             properties:
 *               secret:         { type: string, description: "Shared HMAC secret (mutually exclusive with subscriptionId)" }
 *               subscriptionId: { type: string, description: "Verify against a subscription's primary + previous keys" }
 *               timestamp: { type: string, description: "Value of X-Webhook-Timestamp header" }
 *               rawBody:   { type: string, description: "Raw (unparsed) JSON body string" }
 *               signature: { type: string, description: "Value of X-Webhook-Signature header (sha256=...)" }
 *     responses:
 *       200:
 *         description: Verification result
 *       400:
 *         description: Validation error
 */
webhooksRouter.post(
  "/verify",
  async (req: Request, res: Response): Promise<void> => {
    const { secret, subscriptionId, timestamp, rawBody, signature } = req.body ?? {};

    if (
      typeof timestamp !== "string" ||
      typeof rawBody !== "string" ||
      typeof signature !== "string" ||
      (secret === undefined && subscriptionId === undefined)
    ) {
      res.status(400).json({
        error: "validation",
        message:
          "Provide timestamp (string), rawBody (string), signature (string), and either secret (string) or subscriptionId (string)",
      });
      return;
    }

    if (subscriptionId !== undefined) {
      if (typeof subscriptionId !== "string") {
        res.status(400).json({ error: "validation", message: "`subscriptionId` must be a string" });
        return;
      }
      const valid = await verifySubscriptionSignature(subscriptionId, timestamp, rawBody, signature);
      res.json({
        valid,
        message: valid
          ? "Signature is valid."
          : "Signature is invalid, the timestamp is outside the 5-minute tolerance window, or no active key on this subscription matches.",
      });
      return;
    }

    if (typeof secret !== "string") {
      res.status(400).json({ error: "validation", message: "`secret` must be a string" });
      return;
    }

    const valid = verifySignature(secret, timestamp, rawBody, signature);
    res.json({
      valid,
      message: valid
        ? "Signature is valid."
        : "Signature is invalid or the timestamp is outside the 5-minute tolerance window.",
    });
  }
);
