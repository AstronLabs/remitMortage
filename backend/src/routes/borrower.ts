import { Router } from "express";
import { validateBorrowerParams } from "../middleware/validate.js";
import { getApplicant } from "../services/db.js";

export const borrowerRouter = Router();

/**
 * @openapi
 * /api/borrower/{address}/status:
 *   get:
 *     summary: Get borrower status
 *     description: Returns the current borrower verification and loan status from the database.
 *     tags:
 *       - Borrower
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         description: Borrower Stellar public key.
 *         schema:
 *           type: string
 *           pattern: '^G[A-Z2-7]{55}$'
 *         example: GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF
 *     responses:
 *       200:
 *         description: Borrower status summary.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/BorrowerStatusResponse'
 *       500:
 *         description: Borrower status lookup failed unexpectedly.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
borrowerRouter.get("/:address/status", validateBorrowerParams, async (req, res) => {
  try {
    const address = Array.isArray(req.params.address)
      ? req.params.address[0]
      : req.params.address;

    const applicant = await getApplicant(address).catch((err) => {
      console.error("DB read error (non-fatal):", err);
      return null;
    });

    const latestVerification = applicant?.verificationResults[0] ?? null;
    const latestLoan = applicant?.loanApplications[0] ?? null;

    res.json({
      address,
      verificationStatus: applicant?.verificationStatus ?? "PENDING",
      creditScore: applicant?.creditScore ?? null,
      verification: latestVerification
        ? {
            eligible: latestVerification.eligible,
            totalPayments: latestVerification.totalPayments,
            totalVolume: latestVerification.totalVolume,
            spanMonths: latestVerification.spanMonths,
            reportHash: latestVerification.reportHash,
            analyzedAt: latestVerification.analyzedAt,
          }
        : null,
      loan: latestLoan
        ? {
            status: latestLoan.status,
            principal: String(latestLoan.principal),
            escrowContractId: latestLoan.escrowContractId ?? null,
            loanId: latestLoan.loanId ?? null,
          }
        : { status: "none", principal: "0" },
    });
  } catch (error) {
    console.error("Borrower status error:", error);
    res.status(500).json({ error: "Failed to fetch borrower status" });
  }
});
