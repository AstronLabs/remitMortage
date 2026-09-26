import { NextResponse } from "next/server";
import {
  computeSegments,
  sumAllocations,
  type LoanAllocation,
  type RiskTier,
  type Tranche,
} from "../../../../lib/portfolioBreakdown";

/** Small deterministic PRNG so a given wallet always sees the same mock breakdown. */
function mulberry32(seed: number) {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromWallet(wallet: string): number {
  let hash = 0;
  for (let i = 0; i < wallet.length; i++) {
    hash = (Math.imul(31, hash) + wallet.charCodeAt(i)) | 0;
  }
  return hash;
}

const LOAN_POOL: Array<{
  id: string;
  borrower: string;
  region: string;
  tranche: Tranche;
  riskTier: RiskTier;
  apyBps: number;
}> = [
  { id: "loan-201", borrower: "GBORROWER1NA1111111111111111111111111111111111111111", region: "North America", tranche: "Senior", riskTier: "Low", apyBps: 420 },
  { id: "loan-202", borrower: "GBORROWER2NA2222222222222222222222222222222222222222", region: "North America", tranche: "Senior", riskTier: "Low", apyBps: 410 },
  { id: "loan-203", borrower: "GBORROWER3EU1111111111111111111111111111111111111111", region: "Europe", tranche: "Senior", riskTier: "Medium", apyBps: 480 },
  { id: "loan-204", borrower: "GBORROWER4EU2222222222222222222222222222222222222222", region: "Europe", tranche: "Junior", riskTier: "Medium", apyBps: 720 },
  { id: "loan-205", borrower: "GBORROWER5AP1111111111111111111111111111111111111111", region: "Asia Pacific", tranche: "Junior", riskTier: "High", apyBps: 950 },
  { id: "loan-206", borrower: "GBORROWER6LATAM1111111111111111111111111111111111111", region: "Latin America", tranche: "Senior", riskTier: "Low", apyBps: 400 },
  { id: "loan-207", borrower: "GBORROWER7AF1111111111111111111111111111111111111111", region: "Africa & ME", tranche: "Junior", riskTier: "High", apyBps: 990 },
  { id: "loan-208", borrower: "GBORROWER8NA3333333333333333333333333333333333333333", region: "North America", tranche: "Junior", riskTier: "Medium", apyBps: 700 },
];

/**
 * Splits the investor's total deposited capital across a random subset of the
 * loan pool. Works in integer cents throughout so the generated allocations
 * always sum exactly to `totalDepositedCents`.
 */
function allocateLoans(totalDepositedCents: number, random: () => number): LoanAllocation[] {
  if (totalDepositedCents <= 0) return [];

  const poolSize = 3 + Math.floor(random() * (LOAN_POOL.length - 3));
  const shuffled = [...LOAN_POOL].sort(() => random() - 0.5).slice(0, poolSize);

  const weights = shuffled.map(() => 0.5 + random());
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  let remainingCents = totalDepositedCents;
  const allocations: LoanAllocation[] = [];

  shuffled.forEach((loan, i) => {
    const isLast = i === shuffled.length - 1;
    const shareCents = isLast
      ? remainingCents
      : Math.min(remainingCents, Math.round((weights[i] / totalWeight) * totalDepositedCents));
    remainingCents -= shareCents;

    if (shareCents > 0) {
      allocations.push({
        loanId: loan.id,
        borrower: loan.borrower,
        region: loan.region,
        tranche: loan.tranche,
        riskTier: loan.riskTier,
        allocatedAmount: shareCents / 100,
        apyBps: loan.apyBps,
      });
    }
  });

  return allocations;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get("wallet");
  const depositedParam = searchParams.get("totalDeposited");

  if (!wallet) {
    return NextResponse.json({ error: "Wallet parameter is required" }, { status: 400 });
  }

  const totalDeposited = depositedParam !== null ? parseFloat(depositedParam) : NaN;
  const fallbackDollars = 5000 + ((seedFromWallet(wallet) >>> 0) % 45000);
  const totalDepositedCents = Number.isFinite(totalDeposited) && totalDeposited > 0
    ? Math.round(totalDeposited * 100)
    : fallbackDollars * 100;

  const random = mulberry32(seedFromWallet(wallet));
  const loans = allocateLoans(totalDepositedCents, random);
  const segments = computeSegments(loans);

  return NextResponse.json({
    wallet,
    totalDeposited: sumAllocations(loans),
    segments,
  });
}
