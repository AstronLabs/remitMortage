import { Router } from "express";
import crypto from "crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { analyzeRemittanceHistory } from "../services/stellar.js";
import { hashReportContent, streamVerificationPdf, VerificationReport } from "../services/pdf.js";
import { calculateCreditScore } from "../services/scoring.js";
import { validateVerificationBody, validateMultiChainOwnership } from "../middleware/validate.js";
import { verificationChallengeRateLimiter } from "../middleware/rateLimit.js";
import { createChallenge, consumeChallenge } from "../services/challengeStore.js";
import { verifyEvmSignature } from "../services/evm.js";
import { verifySolanaSignature } from "../services/solana.js";
import { prisma } from "../services/db.js";

export const verificationRouter = Router();

/**
 * @openapi
 * /api/verification/check:
 *   post:
 *     summary: Analyze remittance payment history
 *     tags: [Verification]
 *     description: |
 *       Accepts a Stellar sender wallet and recipient address, queries Horizon for
 *       outgoing USDC payments, and returns a remittance eligibility summary.
 *       The response also includes a `reportId` and `reportHash` — the SHA-256
 *       hash of the report content — ready for on-chain anchoring in the
 *       verification registry contract.
 *     tags:
 *       - Verification
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/VerificationCheckRequest'
 *     responses:
 *       200:
 *         description: Remittance analysis completed.
 *       400:
 *         description: Required request fields are missing.
 *       500:
 *         description: Verification service failed unexpectedly.
 */
verificationRouter.post("/check", validateVerificationBody, async (req, res) => {
  try {
    const { senderAddress, recipientAddress } = req.body;
    const analysis = await analyzeRemittanceHistory(senderAddress, recipientAddress);

    const reportId = crypto.randomUUID();
    const generatedAt = new Date();

    const reportHash = hashReportContent(reportId, generatedAt.toISOString(), analysis);

    const applicant = await prisma.applicant.upsert({
      where: { stellarAddress: senderAddress },
      update: {},
      create: { stellarAddress: senderAddress },
    });

    await prisma.verificationResult.create({
      data: {
        id: reportId,
        applicantId: applicant.id,
        reportHash,
        generatedAt,
        analysis,
        firstPayment: analysis.firstPayment ? new Date(analysis.firstPayment) : null,
        lastPayment: analysis.lastPayment ? new Date(analysis.lastPayment) : null,
        totalPayments: analysis.totalPayments,
        eligible: analysis.eligible,
      },
    });

    res.json({
      ...analysis,
      reportId,
      generatedAt: generatedAt.toISOString(),
      reportHash,
    });
  } catch (error) {
    console.error("Verification error:", error);
    res.status(500).json({ error: "Verification service failed" });
  }
});

/**
 * @openapi
 * /api/verification/report/{reportId}:
 *   get:
 *     summary: Download a PDF verification report
 *     description: |
 *       Streams a formatted, branded PDF report for the given report ID.
 *       The report includes the full RemittanceAnalysis result — sender/recipient
 *       addresses, payment history, eligibility verdict, and a SHA-256 hash
 *       footer for on-chain verification.
 *     tags:
 *       - Verification
 *     parameters:
 *       - in: path
 *         name: reportId
 *         required: true
 *         description: Unique report ID returned by POST /api/verification/check.
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: PDF report streamed for download.
 *         content:
 *           application/pdf:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Report not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: PDF generation failed unexpectedly.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
verificationRouter.get("/report/:reportId", async (req, res) => {
  try {
    const { reportId } = req.params;
    const record = await prisma.verificationResult.findUnique({
      where: { id: reportId },
    });

    if (!record) {
      return res.status(404).json({
        error: "report_not_found",
        message: `No report found for ID: ${reportId}`,
      });
    }

    const report: VerificationReport = {
      reportId: record.id,
      generatedAt: record.generatedAt.toISOString(),
      analysis: record.analysis as any,
      reportHash: record.reportHash,
    };

    const filename = `remitmortgage-verification-${reportId.slice(0, 8)}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );

    streamVerificationPdf(report, res);
  } catch (error) {
    console.error("PDF generation error:", error);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

/**
 * @openapi
 * /api/verification/score:
 *   post:
 *     summary: Calculate borrower credit score
 *     tags: [Verification]
 *     description: Analyzes remittance history and calculates a 0-100 credit score with tier mapping.
 *     tags:
 *       - Verification
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/VerificationCheckRequest'
 *     responses:
 *       200:
 *         description: Scoring completed successfully.
 *       400:
 *         description: Missing fields.
 *       500:
 *         description: Scoring service failed.
 */
verificationRouter.post("/score", validateVerificationBody, async (req, res) => {
  try {
    const { senderAddress, recipientAddress } = req.body;
    const analysisResult = await analyzeRemittanceHistory(senderAddress, recipientAddress);
    const scoreResult = calculateCreditScore(analysisResult);
    res.json(scoreResult);
  } catch (error) {
    console.error("Scoring error:", error);
    res.status(500).json({ error: "Scoring service failed" });
  }
});

/**
 * @openapi
 * /api/verification/challenge:
 *   post:
 *     summary: Issue a wallet-ownership challenge
 *     tags: [Verification]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [walletAddress, network]
 *             properties:
 *               walletAddress:
 *                 type: string
 *               network:
 *                 type: string
 *                 enum: [stellar, ethereum, solana]
 *     responses:
 *       200:
 *         description: Challenge string to sign.
 *       400:
 *         description: Invalid or missing walletAddress / network.
 */
verificationRouter.post("/challenge", verificationChallengeRateLimiter, validateMultiChainOwnership, (req, res) => {
  const { walletAddress } = req.body;
  const challenge = createChallenge(walletAddress);
  res.json({ challenge });
});

/**
 * @openapi
 * /api/verification/verify-ownership:
 *   post:
 *     summary: Verify a signed wallet-ownership challenge
 *     tags: [Verification]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [walletAddress, network, challenge, signature]
 *             properties:
 *               walletAddress:
 *                 type: string
 *               network:
 *                 type: string
 *                 enum: [stellar, ethereum, solana]
 *               challenge:
 *                 type: string
 *               signature:
 *                 type: string
 *                 description: Hex-encoded signature of the challenge.
 *     responses:
 *       200:
 *         description: Ownership verified.
 *       400:
 *         description: Missing required fields.
 *       401:
 *         description: Invalid signature.
 *       410:
 *         description: Challenge expired or already used.
 */
verificationRouter.post("/verify-ownership", verificationChallengeRateLimiter, validateMultiChainOwnership, (req, res) => {
  const { walletAddress, network, challenge, signature } = req.body;

  if (!challenge || !signature) {
    res.status(400).json({ error: "missing_field", message: "challenge and signature are required" });
    return;
  }

  const result = consumeChallenge(walletAddress, challenge);
  if (!result.ok) {
    res.status(410).json({ error: "challenge_invalid", reason: result.reason });
    return;
  }

  let valid = false;
  try {
    if (network === "stellar") {
      const keypair = Keypair.fromPublicKey(walletAddress);
      const messageBytes = Buffer.from(challenge, "utf8");
      const sigBytes = Buffer.from(signature, "hex");
      valid = keypair.verify(messageBytes, sigBytes);
    } else if (network === "ethereum") {
      valid = verifyEvmSignature(walletAddress, challenge, signature);
    } else if (network === "solana") {
      valid = verifySolanaSignature(walletAddress, challenge, signature);
    }
  } catch {
    valid = false;
  }

  if (!valid) {
    res.status(401).json({ error: "invalid_signature" });
    return;
  }

  res.json({ verified: true, walletAddress, network });
});
