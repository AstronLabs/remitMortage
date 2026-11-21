// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import axios from "axios";
import { prisma } from "../services/db.js";
import { getInvestorInfo } from "../services/soroban.js";
import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";

export type InvestorPositionRecord = {
  id: string; walletAddress: string; deposited: string; claimedYield: string;
  startLedger: number; tranche: string; accruedYield: string; absorbedLoss: string;
};
export type InvestorMismatch = { walletAddress: string; fields: string[]; safe: boolean; database: InvestorPositionRecord; onChain: Record<string, unknown> };
export type InvestorReconciliationResult = { scanned: number; mismatches: InvestorMismatch[]; corrected: number; alerted: boolean; errors: number };

const fields = ["deposited", "claimedYield", "startLedger", "tranche", "accruedYield", "absorbedLoss"] as const;
const safeFields = new Set(["accruedYield"]);

type ReconciliationDeps = {
  client?: any;
  readPosition?: (contractId: string, walletAddress: string) => Promise<Record<string, unknown>>;
  alert?: (mismatches: InvestorMismatch[]) => Promise<boolean>;
};

async function sendAlert(mismatches: InvestorMismatch[]) {
  const url = loadConfig().alertWebhookUrl;
  if (!url) return false;
  try {
    await axios.post(url, { text: `⚠️ Investor position reconciliation found ${mismatches.length} discrepancy(ies).\n${mismatches.map((m) => `• ${m.walletAddress}: ${m.fields.join(", ")}`).join("\n")}` }, { timeout: 5_000 });
    return true;
  } catch (error) {
    logger.error("[investor-reconciliation] alert failed", { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

export async function runInvestorPositionReconciliation(deps: ReconciliationDeps = {}): Promise<InvestorReconciliationResult> {
  const client = deps.client ?? prisma;
  const read = deps.readPosition ?? getInvestorInfo;
  const positions = await client.investorPosition.findMany();
  const result: InvestorReconciliationResult = { scanned: positions.length, mismatches: [], corrected: 0, alerted: false, errors: 0 };
  const contractId = loadConfig().lendingPoolContractId;

  for (const database of positions as InvestorPositionRecord[]) {
    try {
      const rawOnChain = (await read(contractId, database.walletAddress)) as Record<string, any>;
      const onChain: Record<string, unknown> = {
        deposited: rawOnChain.deposited ?? rawOnChain.deposited_amount,
        claimedYield: rawOnChain.claimedYield ?? rawOnChain.claimed_yield,
        startLedger: rawOnChain.startLedger ?? rawOnChain.start_ledger,
        tranche: rawOnChain.tranche,
        accruedYield: rawOnChain.accruedYield ?? rawOnChain.accrued_yield,
        absorbedLoss: rawOnChain.absorbedLoss ?? rawOnChain.absorbed_loss,
      };
      const mismatchedFields = fields.filter((field) => String(database[field]) !== String(onChain[field] ?? ""));
      if (mismatchedFields.length === 0) continue;
      const mismatch = { walletAddress: database.walletAddress, fields: mismatchedFields, safe: mismatchedFields.every((field) => safeFields.has(field)), database, onChain };
      result.mismatches.push(mismatch);
      await client.auditLog.create({ data: { action: "INVESTOR_POSITION_MISMATCH", actorAddress: database.walletAddress, metadata: mismatch } });
      if (mismatch.safe) {
        await client.investorPosition.update({ where: { id: database.id }, data: { accruedYield: String(onChain.accruedYield ?? database.accruedYield) } });
        result.corrected += 1;
        await client.auditLog.create({ data: { action: "INVESTOR_POSITION_CORRECTED", actorAddress: database.walletAddress, metadata: { fields: mismatchedFields, source: "on-chain" } } });
      }
    } catch (error) {
      result.errors += 1;
      logger.error("[investor-reconciliation] position failed", { walletAddress: database.walletAddress, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (result.mismatches.some((m) => !m.safe)) result.alerted = await (deps.alert ?? sendAlert)(result.mismatches.filter((m) => !m.safe));
  await client.auditLog.create({ data: { action: "INVESTOR_POSITION_RECONCILIATION_RUN", metadata: { scanned: result.scanned, mismatches: result.mismatches.length, corrected: result.corrected, errors: result.errors, alerted: result.alerted } } });
  return result;
}
