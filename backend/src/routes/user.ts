// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router, Response } from "express";
import { AuthenticatedRequest, authMiddleware } from "../middleware/auth.js";
import { getUserDataExport, processUserDataDeletion } from "../services/db.js";
import logger from "../utils/logger.js";

export const userRouter = Router();

// Apply authMiddleware to all routes under /api/user
userRouter.use(authMiddleware);

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
