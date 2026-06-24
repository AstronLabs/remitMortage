import { Router } from "express";
import { analyzeRemittanceHistory } from "../services/stellar.js";

export const verificationRouter = Router();

/**
 * @openapi
 * /api/verification/check:
 *   post:
 *     summary: Analyze remittance payment history
 *     description: Accepts a Stellar sender wallet and recipient address, queries Horizon for outgoing USDC payments, and returns a remittance eligibility summary.
 *     tags:
 *       - Verification
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/VerificationCheckRequest'
 *           examples:
 *             check:
 *               value:
 *                 senderAddress: GDXU35N4YDZTX4LU6KM2P5WNOWIBLDE2DYUNCCXKMAO4NSV3WVNGLJXZ
 *                 recipientAddress: GBRO6TWF5WNRQKUER75INAECJVDFKW2PKHV3B6CNBFUYFUOSTWKMHEGB
 *     responses:
 *       200:
 *         description: Remittance analysis completed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RemittanceAnalysis'
 *       400:
 *         description: Required request fields are missing.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Verification service failed unexpectedly.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
verificationRouter.post("/check", async (req, res) => {
  try {
    const { senderAddress, recipientAddress } = req.body;

    if (!senderAddress || !recipientAddress) {
      res.status(400).json({
        error: "Missing required fields: senderAddress, recipientAddress",
      });
      return;
    }

    const result = await analyzeRemittanceHistory(
      senderAddress,
      recipientAddress
    );

    res.json(result);
  } catch (error) {
    console.error("Verification error:", error);
    res.status(500).json({ error: "Verification service failed" });
  }
});
