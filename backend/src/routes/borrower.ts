import { Router } from "express";
import logger from "../utils/logger.js";
import { validateBorrowerParams } from "../middleware/validate.js";
import { loadConfig } from "../config.js";
import {
  getBorrowerBalance,
  getEscrowConfig,
  getLoanInfo,
  getPoolLiquidity,
  DEFAULT_GOAL_ID,
} from "../services/soroban.js";
import { getApplicant } from "../services/db.js";

export const borrowerRouter = Router();

const config = loadConfig();

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
  const address = String(req.params.address);
  const goalId = typeof req.query.goal === "string" ? req.query.goal : DEFAULT_GOAL_ID;
  const loanId = typeof req.query.loanId === "string" ? req.query.loanId : undefined;

  try {
    // Run the independent on-chain reads concurrently. Each is best-effort so a
    // single missing record (e.g. no loan yet) does not blank the whole status.
    const [borrowerResult, configResult, liquidityResult, loanResult] =
      await Promise.allSettled([
        getBorrowerBalance(config.escrowContractId, address, goalId),
        getEscrowConfig(config.escrowContractId),
        getPoolLiquidity(config.lendingPoolContractId),
        loanId ? getLoanInfo(config.lendingPoolContractId, loanId) : Promise.resolve(null),
      ]);

    // If every query failed, the chain/RPC is effectively unreachable.
    const allFailed = [borrowerResult, configResult, liquidityResult].every(
      (r) => r.status === "rejected"
    );
    if (allFailed) {
      console.error(
        "Borrower status on-chain queries failed:",
        borrowerResult.status === "rejected" ? borrowerResult.reason : undefined
      );
      return res.status(502).json({
        error: "on_chain_unavailable",
        message: "Unable to query Soroban contracts. Please retry shortly.",
      });
    }

    const borrower = borrowerResult.status === "fulfilled" ? borrowerResult.value : null;
    const escrowConfig = configResult.status === "fulfilled" ? configResult.value : null;
    const liquidity = liquidityResult.status === "fulfilled" ? liquidityResult.value : null;
    const loan = loanResult.status === "fulfilled" ? loanResult.value : null;

    const deposited = borrower?.deposited ?? "0";
    const target = borrower?.target_amount ?? escrowConfig?.savings_target ?? "0";
    const progress = computeProgress(deposited, target);
    const address = Array.isArray(req.params.address)
      ? req.params.address[0]
      : req.params.address;

    const applicant = await getApplicant(address).catch((err) => {
      console.error("DB read error (non-fatal):", err);
      return null;
    });

    const latestVerification = applicant?.verificationResults[0] ?? null;
    const latestLoan = applicant?.loanApplications[0] ?? null;

    return res.json({
      address,
      escrow: {
        deposited,
        target,
        progress,
        startLedger: borrower?.start_ledger ?? null,
        released: borrower?.released ?? false,
        withdrawn: borrower?.withdrawn ?? false,
      },
      loan: loan
        ? {
            status: loan.status,
            principal: loan.principal,
            disbursed: loan.disbursed,
            repaid: loan.repaid,
            outstandingDebt: loan.outstanding_debt,
          }
        : {
            status: "none",
            principal: "0",
            disbursed: "0",
            repaid: "0",
          },
      pool: {
        availableLiquidity: liquidity ?? "0",
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
            principal: String(latestLoan.principal),
            escrowContractId: latestLoan.escrowContractId ?? null,
            loanId: latestLoan.loanId ?? null,
          }
        : { status: "none", principal: "0" },
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
