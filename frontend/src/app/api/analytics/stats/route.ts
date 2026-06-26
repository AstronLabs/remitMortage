import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    totalValueLocked: 1250000,
    activeLoanVolume: 875000,
    averageCreditScore: 720,
    totalMilestonesCompleted: 156,
    activeBorrowers: 42,
    loansDisbursed: 15,
    lastUpdated: new Date().toISOString(),
  });
}
