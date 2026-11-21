// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { NextRequest, NextResponse } from "next/server";

/**
 * A recorded investor transaction. Amounts are positive whole-token USDC
 * strings (7-decimal precision preserved); `type` gives the direction.
 */
export type InvestorTransactionRecord = {
  id: string;
  type: "deposit" | "withdrawal" | "yield";
  /** ISO-8601 settlement timestamp. */
  date: string;
  amount: string;
  txHash: string;
  status: "Completed";
};

export type InvestorTransactionsResponse = {
  investorAddress: string;
  /** ISO-8601 timestamp the investor's account was opened. */
  accountOpenedAt: string;
  transactions: InvestorTransactionRecord[];
};

const ACCOUNT_OPENED_AT = "2026-01-14T10:00:00Z";

function hash(seed: string): string {
  return seed.padEnd(64, "0").slice(0, 64);
}

/**
 * Mock duplicate of what the lending-pool deposit/withdrawal indexer will serve
 * for an investor. Covers deposits, a withdrawal, monthly yield accruals and a
 * month with no activity at all (May 2026) so statements exercise every case.
 */
const MOCK_TRANSACTIONS: InvestorTransactionRecord[] = [
  { id: "inv-dep-1", type: "deposit", date: "2026-01-14T10:05:00Z", amount: "5000.00", txHash: hash("de01"), status: "Completed" },
  { id: "inv-yld-1", type: "yield", date: "2026-01-31T23:00:00Z", amount: "12.3456789", txHash: hash("y101"), status: "Completed" },
  { id: "inv-dep-2", type: "deposit", date: "2026-02-03T08:30:00Z", amount: "2500.00", txHash: hash("de02"), status: "Completed" },
  { id: "inv-yld-2", type: "yield", date: "2026-02-28T23:00:00Z", amount: "48.1200000", txHash: hash("y102"), status: "Completed" },
  { id: "inv-wd-1", type: "withdrawal", date: "2026-03-10T15:45:00Z", amount: "1200.00", txHash: hash("wd01"), status: "Completed" },
  { id: "inv-yld-3", type: "yield", date: "2026-03-31T23:00:00Z", amount: "45.0000001", txHash: hash("y103"), status: "Completed" },
  { id: "inv-yld-4", type: "yield", date: "2026-04-30T23:00:00Z", amount: "44.80", txHash: hash("y104"), status: "Completed" },
  // May 2026 intentionally has no activity.
  { id: "inv-dep-3", type: "deposit", date: "2026-06-01T00:00:00Z", amount: "1000.00", txHash: hash("de03"), status: "Completed" },
  { id: "inv-yld-6", type: "yield", date: "2026-06-30T23:00:00Z", amount: "51.25", txHash: hash("y106"), status: "Completed" },
  { id: "inv-yld-7", type: "yield", date: "2026-07-31T23:00:00Z", amount: "52.10", txHash: hash("y107"), status: "Completed" },
  { id: "inv-wd-2", type: "withdrawal", date: "2026-08-15T12:00:00Z", amount: "500.00", txHash: hash("wd02"), status: "Completed" },
  { id: "inv-yld-8", type: "yield", date: "2026-08-31T23:00:00Z", amount: "49.95", txHash: hash("y108"), status: "Completed" },
  { id: "inv-yld-9", type: "yield", date: "2026-09-30T23:00:00Z", amount: "50.40", txHash: hash("y109"), status: "Completed" },
  { id: "inv-yld-10", type: "yield", date: "2026-10-31T23:00:00Z", amount: "51.05", txHash: hash("y110"), status: "Completed" },
];

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ publicKey: string }> }
) {
  try {
    const { publicKey } = await params;
    const body: InvestorTransactionsResponse = {
      investorAddress: publicKey,
      accountOpenedAt: ACCOUNT_OPENED_AT,
      transactions: MOCK_TRANSACTIONS,
    };
    return NextResponse.json(body);
  } catch (error) {
    console.error("Investor transactions API error:", error);
    return NextResponse.json({ error: "Failed to fetch investor transactions" }, { status: 500 });
  }
}
