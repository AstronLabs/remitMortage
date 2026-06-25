import { Horizon } from "@stellar/stellar-sdk";
import logger from "../utils/logger.js";
import { loadConfig } from "../config.js";

const config = loadConfig();
const server = new Horizon.Server(config.horizonUrl);

export interface RemittanceAnalysis {
  senderAddress: string;
  recipientAddress: string;
  totalPayments: number;
  totalAmountUSDC: string;
  averageAmountUSDC: string;
  standardDeviation: number;
  firstPayment: string | null;
  lastPayment: string | null;
  spanMonths: number;
  eligible: boolean;
  reason: string;
}

/**
 * Queries Stellar Horizon for outgoing USDC payments from sender
 * to recipient and analyzes the pattern for remittance consistency.
 */
export async function analyzeRemittanceHistory(
  senderAddress: string,
  recipientAddress: string
): Promise<RemittanceAnalysis> {
  const payments: Array<{ amount: string; date: string }> = [];

  try {
    // Fetch payment operations for the sender account.
    const operationsPage = await server
      .operations()
      .forAccount(senderAddress)
      .limit(200)
      .order("desc")
      .call();

    for (const op of operationsPage.records) {
      // Filter for payment operations to the recipient.
      if (
        op.type === "payment" &&
        "to" in op &&
        "asset_code" in op &&
        op.to === recipientAddress &&
        op.asset_code === "USDC"
      ) {
        payments.push({
          amount: (op as any).amount,
          date: op.created_at,
        });
      }
    }
  } catch (error) {
    logger.error("Horizon query error", { error });
    return {
      senderAddress,
      recipientAddress,
      totalPayments: 0,
      totalAmountUSDC: "0",
      averageAmountUSDC: "0",
      standardDeviation: 0,
      firstPayment: null,
      lastPayment: null,
      spanMonths: 0,
      eligible: false,
      reason: "Failed to query Stellar Horizon",
    };
  }

  if (payments.length === 0) {
    return {
      senderAddress,
      recipientAddress,
      totalPayments: 0,
      totalAmountUSDC: "0",
      averageAmountUSDC: "0",
      standardDeviation: 0,
      firstPayment: null,
      lastPayment: null,
      spanMonths: 0,
      eligible: false,
      reason: "No USDC payments found to recipient",
    };
  }

  // Sort oldest first.
  payments.sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  const totalAmount = payments.reduce(
    (sum, p) => sum + parseFloat(p.amount),
    0
  );
  const avgAmount = totalAmount / payments.length;

  const variance = payments.reduce((sum, p) => sum + Math.pow(parseFloat(p.amount) - avgAmount, 2), 0) / payments.length;
  const standardDeviation = Math.sqrt(variance);

  const firstDate = new Date(payments[0].date);
  const lastDate = new Date(payments[payments.length - 1].date);
  const spanMonths = Math.round(
    (lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24 * 30)
  );

  // Eligibility: at least 6 payments over at least 3 months.
  const eligible = payments.length >= 6 && spanMonths >= 3;

  return {
    senderAddress,
    recipientAddress,
    totalPayments: payments.length,
    totalAmountUSDC: totalAmount.toFixed(2),
    averageAmountUSDC: avgAmount.toFixed(2),
    standardDeviation,
    firstPayment: payments[0].date,
    lastPayment: payments[payments.length - 1].date,
    spanMonths,
    eligible,
    reason: eligible
      ? "Meets minimum remittance consistency requirements"
      : `Insufficient history: ${payments.length} payments over ${spanMonths} months (need ≥6 payments over ≥3 months)`,
  };
}
