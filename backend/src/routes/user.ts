// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router, Response } from "express";
import { AuthenticatedRequest, authMiddleware } from "../middleware/auth.js";
import { getUserDataExport, processUserDataDeletion } from "../services/db.js";
import {
  COMMUNICATION_CATEGORIES,
  COMMUNICATION_CHANNELS,
  getCommunicationPreferences,
  updateCommunicationPreferences,
  type CommunicationCategory,
  type CommunicationChannel,
  type CommunicationPreferenceUpdate,
} from "../services/communicationPreferences.js";
import logger from "../utils/logger.js";

export const userRouter = Router();

// Apply authMiddleware to all routes under /api/user
userRouter.use(authMiddleware);

function isValidCommunicationCategory(value: unknown): value is CommunicationCategory {
  return typeof value === "string" && (COMMUNICATION_CATEGORIES as string[]).includes(value);
}

function isValidCommunicationChannel(value: unknown): value is CommunicationChannel {
  return typeof value === "string" && (COMMUNICATION_CHANNELS as string[]).includes(value);
}

/**
 * @openapi
 * /api/user/data-export:
 *   get:
 *     summary: Export personal user data
 *     description: >-
 *       Compiles all off-chain PII, KYC metadata, verifications, loan applications,
 *       and on-chain financial records for the requesting user into a downloadable JSON archive.
 *     tags:
 *       - User Data Protection
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Downloadable data export JSON archive.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Authentication token missing or invalid.
 *       500:
 *         description: Failed to generate data export archive.
 */
userRouter.get("/data-export", async (req: AuthenticatedRequest, res: Response) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) {
    return res.status(401).json({ error: "unauthorized", message: "User wallet address required" });
  }

  try {
    const dataExport = await getUserDataExport(walletAddress);

    const filename = `data-export-${walletAddress.slice(0, 8)}-${Date.now()}.json`;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    return res.status(200).json(dataExport);
  } catch (error) {
    logger.error("Failed to compile user data export", { walletAddress, error });
    return res.status(500).json({ error: "internal_error", message: "Failed to generate data export" });
  }
});

/**
 * @openapi
 * /api/user/data-deletion:
 *   post:
 *     summary: Request account data deletion and anonymization
 *     description: >-
 *       Triggers a data protection deletion workflow. Off-chain PII (taxId, income, KYC metadata, audit logs)
 *       is scrubbed and deleted, while on-chain linked financial records are anonymized to maintain ledger immutability.
 *     tags:
 *       - User Data Protection
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *                 description: Optional reason for deletion request.
 *               confirm:
 *                 type: boolean
 *                 description: Confirmation flag to process deletion.
 *     responses:
 *       200:
 *         description: Deletion and anonymization completed.
 *       400:
 *         description: Explicit confirmation flag mismatch.
 *       401:
 *         description: Authentication token missing or invalid.
 *       500:
 *         description: Failed to process data deletion request.
 */
userRouter.post("/data-deletion", async (req: AuthenticatedRequest, res: Response) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) {
    return res.status(401).json({ error: "unauthorized", message: "User wallet address required" });
  }

  const { reason, confirm } = req.body || {};
  if (confirm === false) {
    return res.status(400).json({
      error: "invalid_request",
      message: "Explicit confirmation required to trigger data deletion and anonymization",
    });
  }

  try {
    const result = await processUserDataDeletion(walletAddress, reason);

    logger.info("User data deletion and anonymization processed successfully", {
      walletAddress,
      requestId: result.id,
    });

    return res.status(200).json({
      message: "Data deletion and anonymization request processed successfully",
      request: {
        id: result.id,
        status: result.status,
        requestedAt: result.requestedAt,
        processedAt: result.processedAt,
        anonymizedAt: result.anonymizedAt,
        details: result.details,
      },
    });
  } catch (error) {
    logger.error("Failed to process user data deletion", { walletAddress, error });
    return res.status(500).json({ error: "internal_error", message: "Failed to process data deletion" });
  }
});

/**
 * @openapi
 * /api/user/communication-preferences:
 *   get:
 *     summary: Get the full per-category, per-channel communication preference matrix
 *     description: >-
 *       Returns whether email/SMS/push is enabled for each notification
 *       category (deposits, milestones, governance, security), along with
 *       the consent timestamp and source recorded for each channel that has
 *       been explicitly opted into. A category/channel with no stored
 *       preference reports the channel's default (email and push on, SMS
 *       off — SMS requires an affirmative opt-in).
 *     tags:
 *       - User Communication Preferences
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: The full preference matrix.
 *       401:
 *         description: Authentication token missing or invalid.
 */
userRouter.get("/communication-preferences", async (req: AuthenticatedRequest, res: Response) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) {
    return res.status(401).json({ error: "unauthorized", message: "User wallet address required" });
  }

  try {
    const preferences = await getCommunicationPreferences(walletAddress);
    return res.json({ preferences });
  } catch (error) {
    logger.error("Failed to fetch communication preferences", { walletAddress, error });
    return res.status(500).json({ error: "internal_error", message: "Failed to fetch communication preferences" });
  }
});

/**
 * @openapi
 * /api/user/communication-preferences:
 *   put:
 *     summary: Update one or more cells of the communication preference matrix
 *     description: >-
 *       Applies a batch of { category, channel, enabled, source? } changes.
 *       Enabling a channel records a fresh consent timestamp/source;
 *       disabling one, or re-enabling one already on, leaves any existing
 *       consent record untouched. Security alerts can never have their email
 *       channel disabled — the whole batch is rejected if any update tries,
 *       so a partial, inconsistent state is never persisted.
 *     tags:
 *       - User Communication Preferences
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [updates]
 *             properties:
 *               updates:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [category, channel, enabled]
 *                   properties:
 *                     category:
 *                       type: string
 *                       enum: [DEPOSITS, MILESTONES, GOVERNANCE, SECURITY]
 *                     channel:
 *                       type: string
 *                       enum: [EMAIL, SMS, PUSH]
 *                     enabled:
 *                       type: boolean
 *                     source:
 *                       type: string
 *     responses:
 *       200:
 *         description: The updated preference matrix.
 *       400:
 *         description: Invalid category/channel/enabled value, or an attempt to disable the security category's email channel.
 *       401:
 *         description: Authentication token missing or invalid.
 */
userRouter.put("/communication-preferences", async (req: AuthenticatedRequest, res: Response) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) {
    return res.status(401).json({ error: "unauthorized", message: "User wallet address required" });
  }

  const rawUpdates = req.body?.updates;
  if (!Array.isArray(rawUpdates) || rawUpdates.length === 0) {
    return res.status(400).json({ error: "invalid_request", message: "updates must be a non-empty array" });
  }
  if (rawUpdates.length > COMMUNICATION_CATEGORIES.length * COMMUNICATION_CHANNELS.length) {
    return res.status(400).json({
      error: "invalid_request",
      message: "updates cannot exceed the number of cells in the preference matrix",
    });
  }

  const updates: CommunicationPreferenceUpdate[] = [];
  for (const raw of rawUpdates) {
    const { category, channel, enabled, source } = raw ?? {};

    if (!isValidCommunicationCategory(category)) {
      return res.status(400).json({
        error: "invalid_category",
        message: `category must be one of: ${COMMUNICATION_CATEGORIES.join(", ")}`,
      });
    }
    if (!isValidCommunicationChannel(channel)) {
      return res.status(400).json({
        error: "invalid_channel",
        message: `channel must be one of: ${COMMUNICATION_CHANNELS.join(", ")}`,
      });
    }
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "invalid_enabled", message: "enabled must be a boolean" });
    }
    if (source !== undefined && typeof source !== "string") {
      return res.status(400).json({ error: "invalid_source", message: "source must be a string" });
    }

    // Security alerts always keep at least an email safety net — the same
    // "always reachable, never fully silenceable" guarantee the notification
    // frequency feature gives security alerts on the timing axis, applied
    // here to channel selection.
    if (category === "SECURITY" && channel === "EMAIL" && enabled === false) {
      return res.status(400).json({
        error: "security_email_required",
        message: "Security alerts must always remain enabled for email — disable SMS or push instead.",
      });
    }

    updates.push({ category, channel, enabled, source });
  }

  try {
    const preferences = await updateCommunicationPreferences(walletAddress, updates);
    return res.json({ success: true, preferences });
  } catch (error) {
    logger.error("Failed to update communication preferences", { walletAddress, error });
    return res.status(500).json({ error: "internal_error", message: "Failed to update communication preferences" });
  }
});
