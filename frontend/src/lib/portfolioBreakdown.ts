export type Tranche = "Senior" | "Junior";
export type RiskTier = "Low" | "Medium" | "High";

export interface LoanAllocation {
  loanId: string;
  borrower: string;
  region: string;
  tranche: Tranche;
  riskTier: RiskTier;
  /** This investor's share of the loan's principal, in USDC. */
  allocatedAmount: number;
  apyBps: number;
}

export interface PortfolioSegment {
  tranche: Tranche;
  riskTier: RiskTier;
  /** Sum of allocatedAmount across this segment's loans, in USDC. */
  amount: number;
  loans: LoanAllocation[];
}

/** Converts a USDC amount to integer cents, rounding to the nearest cent. */
function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/**
 * Groups an investor's per-loan allocations into tranche x risk-tier segments.
 *
 * Sums are accumulated in integer cents rather than floating-point dollars so
 * that segment totals always add back up exactly to the sum of the input
 * allocations, regardless of how many loans or how uneven their amounts are.
 */
export function computeSegments(loans: LoanAllocation[]): PortfolioSegment[] {
  const segmentsByKey = new Map<
    string,
    { tranche: Tranche; riskTier: RiskTier; amountCents: number; loans: LoanAllocation[] }
  >();

  for (const loan of loans) {
    const key = `${loan.tranche}:${loan.riskTier}`;
    const existing = segmentsByKey.get(key);
    if (existing) {
      existing.amountCents += toCents(loan.allocatedAmount);
      existing.loans.push(loan);
    } else {
      segmentsByKey.set(key, {
        tranche: loan.tranche,
        riskTier: loan.riskTier,
        amountCents: toCents(loan.allocatedAmount),
        loans: [loan],
      });
    }
  }

  return Array.from(segmentsByKey.values())
    .map((segment) => ({
      tranche: segment.tranche,
      riskTier: segment.riskTier,
      amount: segment.amountCents / 100,
      loans: segment.loans,
    }))
    .sort((a, b) => b.amount - a.amount);
}

/** Sums a set of segments' amounts, in integer cents to stay exact. */
export function sumSegments(segments: PortfolioSegment[]): number {
  return segments.reduce((cents, segment) => cents + toCents(segment.amount), 0) / 100;
}

/** Sums a set of raw loan allocations, in integer cents to stay exact. */
export function sumAllocations(loans: LoanAllocation[]): number {
  return loans.reduce((cents, loan) => cents + toCents(loan.allocatedAmount), 0) / 100;
}

export function segmentKey(tranche: Tranche, riskTier: RiskTier): string {
  return `${tranche}:${riskTier}`;
}

/** Finds the loans backing a given tranche/risk-tier segment. */
export function loansForSegment(
  segments: PortfolioSegment[],
  tranche: Tranche,
  riskTier: RiskTier
): LoanAllocation[] {
  return segments.find((s) => s.tranche === tranche && s.riskTier === riskTier)?.loans ?? [];
}
