// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router, Request, Response } from "express";
import { incidentBot, PagerDutyEvent } from "../services/incidentBot.js";
import logger from "../utils/logger.js";

export const incidentWebhookRouter = Router();

/**
 * @openapi
 * /api/webhooks/pagerduty:
 *   post:
 *     summary: Ingest PagerDuty incident alerts and dispatch runbooks
 *     description: >-
 *       Receives webhook notifications from PagerDuty (trigger, acknowledge, resolve),
 *       maps them to relevant operational runbooks, posts guidance and deploy context to Slack,
 *       and suppresses duplicate alert spam for acknowledged incidents.
 *     tags:
 *       - Incident Response
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Webhook processed successfully.
 *       400:
 *         description: Malformed webhook payload.
 *       500:
 *         description: Internal server error processing incident alert.
 */
incidentWebhookRouter.post("/", async (req: Request, res: Response) => {
  try {
    const body = req.body;
    if (!body || typeof body !== "object") {
      return res.status(400).json({
        error: "invalid_payload",
        message: "Request body must be a JSON object",
      });
    }

    // PagerDuty v2/v3 sends payloads either wrapped in `messages: [...]` or top-level `event: {...}`
    const rawEvents: PagerDutyEvent[] = Array.isArray(body.messages)
      ? body.messages
      : [body as PagerDutyEvent];

    const results = [];

    for (const rawEvent of rawEvents) {
      const result = await incidentBot.handleWebhook(rawEvent);
      results.push(result);
    }

    return res.status(200).json({
      success: true,
      processed: results.length,
      results,
    });
  } catch (error) {
    logger.error("[IncidentWebhook] Failed to process incoming PagerDuty alert", { error });
    return res.status(500).json({
      error: "internal_error",
      message: "Failed to process incident webhook",
    });
  }
});
