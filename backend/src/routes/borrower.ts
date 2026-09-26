// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router } from "express";
import { validateBorrowerParams } from "../middleware/validate.js";
import { getApplicant, getBorrowerStatus } from "../services/db.js";

export const borrowerRouter = Router();

/**
 * @openapi
 * /api/borrower/{address}/status:
 *   get:
 *     summary: Get borrower status
 *     description: >-
 *       Returns the current borrower escrow and loan status by querying the
 *       deployed Soroban escrow and lending-pool contracts via Soroban RPC.
 *       Results are cached for 30 seconds to limit RPC traffic.
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
 *       - in: query
 *         name: goal
 *         required: false
 *         description: Savings goal identifier used to look up the escrow record.
 *         schema:
 *           type: string
 *       - in: query
 *         name: loanId
 *         required: false
 *         description: 32-byte loan id (hex) to fetch the borrower's loan record.
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Borrower status summary.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/BorrowerStatusResponse'
 *       502:
 *         description: On-chain query failed (RPC unreachable or contract error).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Borrower status lookup failed unexpectedly.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
borrowerRouter.get("/:address/status", validateBorrowerParams, async (req, res) => {
  const address = Array.isArray(req.params.address)
    ? req.params.address[0]
    : req.params.address;

  try {
    const borrower = await getBorrowerStatus(address);
    const applicant = await getApplicant(address).catch((err) => {
      console.error("DB read error (non-fatal):", err);
      return null;
    });

    const deposited = borrower?.escrowBalance ?? "0";
    const target = "0";
    const progress = computeProgress(deposited, target);
    const latestVerification = applicant?.verificationResults[0] ?? null;
    const latestLoan = applicant?.loanApplications[0] ?? null;
    const principal = latestLoan ? String(latestLoan.principal) : "0";

    return res.json({
      address,
      escrow: {
        deposited,
        target,
        progress,
        startLedger: null,
        released: false,
        withdrawn: false,
      },
      pool: {
        availableLiquidity: "0",
      },
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
            principal,
            disbursed: borrower?.totalDisbursed ?? "0",
            repaid: borrower?.totalRepaid ?? "0",
            outstanding: borrower?.loanOutstanding ?? principal,
            escrowContractId: latestLoan.escrowContractId ?? null,
            loanId: latestLoan.loanId ?? null,
          }
        : { status: "none", principal: "0", disbursed: "0", repaid: "0", outstanding: "0" },
    });
  } catch (error) {
    console.error("Borrower status error:", error);
    return res.status(500).json({ error: "Failed to fetch borrower status" });
  }
});

/** Computes a 0-100 savings progress percentage from string stroop amounts. */
function computeProgress(deposited: string, target: string): number {
  try {
    const dep = BigInt(deposited);
    const tgt = BigInt(target);
    if (tgt <= 0n) return 0;
    const pct = Number((dep * 10000n) / tgt) / 100;
    return Math.min(100, Math.max(0, Math.round(pct * 100) / 100));
  } catch {
    return 0;
  }
}
