// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { NextRequest, NextResponse } from "next/server";

/**
 * A settled repayment, already split into principal and interest portions.
 *
 * Amounts are whole-token USDC strings (7-decimal precision preserved) and are
 * expected to satisfy `principal + interest == amount` for each row.
 */
export type BorrowerRepaymentRecord = {
  id: string;
  loanId: string;
  loanName: string;
  /** ISO-8601 settlement timestamp. */
  date: string;
  amount: string;
  principal: string;
  interest: string;
  txHash: string;
  status: "Completed";
};

/**
 * Mock duplicate of what the lending-pool repayment indexer will serve once the
 * Soroban `repay` path is wired up. Kept per-loan and multi-year so the annual
 * statement page can exercise per-loan and combined aggregation.
 */
const MOCK_REPAYMENTS: BorrowerRepaymentRecord[] = [
  // Loan A — Home Construction Loan, 2025 tail.
  ...["07-05", "08-05", "09-05", "10-05", "11-05", "12-05"].map((monthDay, index) => ({
    id: `rep-loan-a-2025-${index + 1}`,
    loanId: "LOAN-A-2025-001",
    loanName: "Home Construction Loan",
    date: `2025-${monthDay}T09:00:00Z`,
    amount: "1200.00",
    principal: "1110.00",
    interest: "90.00",
    txHash: `a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff${String(
      index
    ).padStart(2, "0")}`,
    status: "Completed" as const,
  })),

  // Loan B — Renovation Loan, 2025 tail (one exactly on Dec 31 for boundary checks).
  {
    id: "rep-loan-b-2025-1",
    loanId: "LOAN-B-2025-002",
    loanName: "Renovation Loan",
    date: "2025-11-20T14:30:00Z",
    amount: "850.00",
    principal: "790.00",
    interest: "60.00",
    txHash: "bb11cc22dd33ee44ff5500112233445566778899aabbccddeeff001122334455",
    status: "Completed",
  },
  {
    id: "rep-loan-b-2025-2",
    loanId: "LOAN-B-2025-002",
    loanName: "Renovation Loan",
    date: "2025-12-31T23:30:00Z",
    amount: "850.00",
    principal: "790.00",
    interest: "60.00",
    txHash: "bb11cc22dd33ee44ff5500112233445566778899aabbccddeeff001122334466",
    status: "Completed",
  },

  // Loan A — full 2026 calendar year of repayments.
  ...Array.from({ length: 12 }, (_, index) => {
    const month = String(index + 1).padStart(2, "0");
    return {
      id: `rep-loan-a-2026-${index + 1}`,
      loanId: "LOAN-A-2025-001",
      loanName: "Home Construction Loan",
      date: `2026-${month}-05T09:00:00Z`,
      amount: "1200.00",
      principal: "1120.00",
      interest: "80.00",
      txHash: `cc11dd22ee33ff4400112233445566778899aabbccddeeff00112233445566${String(
        index
      ).padStart(2, "0")}`,
      status: "Completed" as const,
    };
  }),

  // Loan B — quarterly 2026 repayments, including Jan 1 for boundary checks.
  ...["01-01", "04-20", "07-20", "10-20"].map((monthDay, index) => ({
    id: `rep-loan-b-2026-${index + 1}`,
    loanId: "LOAN-B-2025-002",
    loanName: "Renovation Loan",
    date: `2026-${monthDay}T11:15:00Z`,
    amount: "850.00",
    principal: "800.00",
    interest: "50.00",
    txHash: `dd11ee22ff3300112233445566778899aabbccddeeff0011223344556677${String(
      index
    ).padStart(2, "0")}`,
    status: "Completed" as const,
  })),
];

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ publicKey: string }> }
) {
  try {
    const { publicKey } = await params;
    const { searchParams } = new URL(request.url);
    const year = searchParams.get("year");
    const loanId = searchParams.get("loanId");

    let filtered = [...MOCK_REPAYMENTS];

    if (year && year !== "All") {
      filtered = filtered.filter(
        (repayment) => new Date(repayment.date).getUTCFullYear() === Number(year)
      );
    }

    if (loanId && loanId !== "All") {
      filtered = filtered.filter((repayment) => repayment.loanId === loanId);
    }

    return NextResponse.json({
      borrowerAddress: publicKey,
      repayments: filtered,
      totalCount: filtered.length,
    });
  } catch (error) {
    console.error("Borrower repayments API error:", error);
    return NextResponse.json({ error: "Failed to fetch borrower repayments" }, { status: 500 });
  }
}
