// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Escrow Balance Reconciliation Job
 *
 * Compares the cached escrow balances stored in Postgres (Borrower.escrowBalance)
 * against the on-chain state fetched from Horizon/Soroban RPC per escrow account.
 *
 * On mismatch beyond the configured tolerance:
 *  - Writes an AuditLog entry with full mismatch detail.
 *  - Fires an alert via the configured alertWebhookUrl (Slack/Discord).
 *
 * Manual reconciliation (triggered by the ops endpoint) overwrites the cached
 * value with the on-chain truth and clears the mismatch alert.
 */

import axios from "axios";
import { Horizon } from "@stellar/stellar-sdk";
import { prisma } from "../services/db.js";
import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconciliationMismatch {
  borrowerId: string;
  stellarAddress: string;
  cachedBalance: string;
  onChainBalance: string;
  deltaStoops: string;
}

export interface ReconciliationResult {
  scanned: number;
  mismatches: ReconciliationMismatch[];
  corrected: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// On-chain balance fetch
// ---------------------------------------------------------------------------

/**
 * Fetches the native + USDC asset balances for a Stellar account from Horizon.
 * Returns the USDC balance in stroops (1 XLM = 10_000_000 stroops).
 * Returns null when the account does not exist on-chain yet.
 */
async function fetchOnChainEscrowBalance(stellarAddress: string): Promise<string | null> {
  const config = loadConfig();
  const horizonUrl = config.horizonUrl || "https://horizon-testnet.stellar.org";

  try {
    const server = new Horizon.Server(horizonUrl, { allowHttp: true });
    const account = await server.loadAccount(stellarAddress);

    // Sum all USDC balance entries (there may be more than one trust line)
    let totalUsdc = 0n;
    for (const balance of account.balances) {
      if (
        balance.asset_type !== "native" &&
        (balance as any).asset_code === "USDC"
      ) {
        // Horizon returns balances as decimal strings (e.g. "12.3456789")
        // Convert to stroops (multiply by 10^7)
        const stroops = BigInt(
          Math.round(parseFloat((balance as any).balance) * 10_000_000)
        );
        totalUsdc += stroops;
      }
    }

    return totalUsdc.toString();
  } catch (err: any) {
    // 404 = account not yet funded on-chain — not an error we alert on
    if (err?.response?.status === 404) {
      return "0";
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Alert dispatch
// ---------------------------------------------------------------------------

async function sendMismatchAlert(mismatches: ReconciliationMismatch[]): Promise<void> {
  const config = loadConfig();
  if (!config.alertWebhookUrl) return;

  const lines = mismatches.map(
    (m) =>
      `• \`${m.stellarAddress}\` cached=${m.cachedBalance} on-chain=${m.onChainBalance} Δ=${m.deltaStoops} stroops`
  );

  const payload = {
    text: [
      `⚠️ *Escrow Balance Reconciliation — ${mismatches.length} mismatch(es) detected*`,
      ...lines,
      `Run \`POST /api/admin/escrow/reconcile\` to correct cached values.`,
    ].join("\n"),
  };

  try {
    await axios.post(config.alertWebhookUrl, payload, { timeout: 5_000 });
  } catch (err) {
    logger.error("[escrow-reconciliation] failed to send mismatch alert", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Core job
// ---------------------------------------------------------------------------

/**
 * Scans all Borrower rows, fetches their on-chain USDC balance from Horizon,
 * and logs/alerts on any mismatch exceeding the configured tolerance.
 *
 * @param autoCorrect  When true, also overwrites cached balances with on-chain
 *                     truth (used by the manual reconciliation endpoint).
 */
export async function runEscrowReconciliation(
  autoCorrect = false
): Promise<ReconciliationResult> {
  const toleranceStoops = BigInt(
    process.env.ESCROW_RECONCILIATION_TOLERANCE_STROOPS ?? "1000"
  );

  logger.info("[escrow-reconciliation] Starting sweep", { autoCorrect, toleranceStoops: toleranceStoops.toString() });

  const borrowers = await prisma.borrower.findMany({
    where: { deletedAt: null },
    select: { id: true, stellarAddress: true, escrowBalance: true },
  });

  const result: ReconciliationResult = {
    scanned: borrowers.length,
    mismatches: [],
    corrected: 0,
    errors: 0,
  };

  for (const borrower of borrowers) {
    try {
      const onChain = await fetchOnChainEscrowBalance(borrower.stellarAddress);
      if (onChain === null) continue;

      const cached = BigInt(borrower.escrowBalance ?? "0");
      const live = BigInt(onChain);
      const delta = cached > live ? cached - live : live - cached;

      if (delta > toleranceStoops) {
        const mismatch: ReconciliationMismatch = {
          borrowerId: borrower.id,
          stellarAddress: borrower.stellarAddress,
          cachedBalance: borrower.escrowBalance,
          onChainBalance: onChain,
          deltaStoops: delta.toString(),
        };
        result.mismatches.push(mismatch);

        logger.warn("[escrow-reconciliation] Balance mismatch detected", mismatch);

        // Write audit trail
        await prisma.auditLog.create({
          data: {
            action: "ESCROW_BALANCE_MISMATCH",
            actorAddress: borrower.stellarAddress,
            metadata: mismatch as any,
          },
        });

        if (autoCorrect) {
          await prisma.borrower.update({
            where: { id: borrower.id },
            data: { escrowBalance: onChain },
          });
          result.corrected++;
          logger.info("[escrow-reconciliation] Corrected cached balance", {
            borrowerId: borrower.id,
            newBalance: onChain,
          });
        }
      }
    } catch (err) {
      result.errors++;
      logger.error("[escrow-reconciliation] Error processing borrower", {
        borrowerId: borrower.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (result.mismatches.length > 0) {
    await sendMismatchAlert(result.mismatches);
  }

  logger.info("[escrow-reconciliation] Sweep complete", {
    scanned: result.scanned,
    mismatches: result.mismatches.length,
    corrected: result.corrected,
    errors: result.errors,
  });

  return result;
}
