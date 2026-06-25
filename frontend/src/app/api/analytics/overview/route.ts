import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    totalValueLocked: 1250000,
    activeBorrowers: 42,
    activeInvestors: 18,
    loansDisbursed: 15,
    recentActivity: [
      { id: "1", type: "deposit", amount: "5,000 USDC", address: "GCSW...W3RF", timestamp: "2026-06-25T10:30:00Z" },
      { id: "2", type: "approval", amount: "75,000 USDC", address: "GBDR...P9LA", timestamp: "2026-06-25T08:15:00Z" },
      { id: "3", type: "disbursement", amount: "15,000 USDC", address: "GCSW...W3RF", timestamp: "2026-06-24T16:45:00Z" },
      { id: "4", type: "deposit", amount: "12,000 USDC", address: "GA7K...4K2P", timestamp: "2026-06-24T11:20:00Z" },
      { id: "5", type: "repayment", amount: "1,200 USDC", address: "GDT2...X7KL", timestamp: "2026-06-23T09:05:00Z" }
    ]
  });
}
