// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { timingSafeEqual } from "crypto";
import { Router, Request, Response } from "express";
import { loadConfig } from "../config.js";
import {
  recordEmailEvent,
  type ProviderEmailEvent,
} from "../services/emailSuppression.js";
import logger from "../utils/logger.js";

export const emailEventsRouter = Router();

function tokenMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string" || expected.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * @openapi
 * /api/webhooks/email-events:
 *   post:
 *     summary: Ingest email provider bounce and complaint events
 *     description: >-
 *       Receives SendGrid Event Webhook batches. Hard bounces and spam complaints
 *       permanently suppress the address; soft bounces suppress it for an
 *       exponential backoff window. Requires the shared secret configured in
 *       EMAIL_WEBHOOK_SECRET via the `x-webhook-token` header or `token` query param.
 *     tags:
 *       - Notifications
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: array
 *             items:
 *               type: object
 *     responses:
 *       200:
 *         description: Events processed.
 *       400:
 *         description: Malformed payload.
 *       401:
 *         description: Missing or invalid webhook token.
 */
emailEventsRouter.post("/", async (req: Request, res: Response) => {
  const provided = req.header("x-webhook-token") ?? req.query.token;
  if (!tokenMatches(provided, loadConfig().emailWebhookSecret)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const body = req.body;
  const events: ProviderEmailEvent[] | null = Array.isArray(body)
    ? body
    : body && typeof body === "object"
      ? [body]
      : null;
  if (!events) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  try {
    const counts = { hard: 0, soft: 0, complaint: 0, ignored: 0 };
    for (const event of events) {
      const kind = await recordEmailEvent(event);
      counts[kind ?? "ignored"] += 1;
    }
    return res.status(200).json({ processed: events.length, ...counts });
  } catch (error) {
    logger.error("[emailEvents] Failed to process email provider events", {
      error,
    });
    return res.status(500).json({ error: "email_event_processing_failed" });
  }
});
