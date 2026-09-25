// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router } from "express";
import logger from "../utils/logger.js";
import { generateVerificationProof } from "../services/proof.js";

export const verifyRouter = Router();

/**
 * @openapi
 * /api/verify/proof:
 *   post:
 *     summary: Generate a client-side verification registry proof
 *     tags:
 *       - Verification
 *     description: |
 *       Returns a cryptographic proof for a verification report. The payload excludes
 *       sensitive PII and is signed by the backend for third-party client integrations.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reportId]
 *             properties:
 *               reportId:
 *                 type: string
 *                 description: The unique VerificationResult ID
 *     responses:
 *       200:
 *         description: Proof generated successfully.
 *       400:
 *         description: Missing reportId.
 *       404:
 *         description: Verification report not found.
 *       500:
 *         description: Proof generation failed.
 */
verifyRouter.post("/proof", async (req, res) => {
  try {
    const { reportId } = req.body;
    
    if (!reportId) {
      res.status(400).json({ error: "missing_field", message: "reportId is required" });
      return;
    }

    const proof = await generateVerificationProof(reportId);
    res.json(proof);
  } catch (error: any) {
    logger.error("Proof generation error", { error: error.message || error });
    if (error.message && error.message.includes("not found")) {
      res.status(404).json({ error: "not_found", message: error.message });
      return;
    }
    res.status(500).json({ error: "Proof generation failed" });
  }
});
