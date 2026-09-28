import {
  computeSegments,
  loansForSegment,
  segmentKey,
  sumAllocations,
  sumSegments,
  type LoanAllocation,
} from "../portfolioBreakdown";

function loan(overrides: Partial<LoanAllocation> = {}): LoanAllocation {
  return {
    loanId: "loan-1",
    borrower: "GBORROWER1111111111111111111111111111111111111111111",
    region: "North America",
    tranche: "Senior",
    riskTier: "Low",
    allocatedAmount: 100,
    apyBps: 400,
    ...overrides,
  };
}

describe("computeSegments", () => {
  it("groups loans by tranche and risk tier", () => {
    const loans = [
      loan({ loanId: "l1", tranche: "Senior", riskTier: "Low", allocatedAmount: 100 }),
      loan({ loanId: "l2", tranche: "Senior", riskTier: "Low", allocatedAmount: 50 }),
      loan({ loanId: "l3", tranche: "Junior", riskTier: "High", allocatedAmount: 75 }),
    ];

    const segments = computeSegments(loans);

    expect(segments).toHaveLength(2);
    const seniorLow = segments.find((s) => s.tranche === "Senior" && s.riskTier === "Low");
    expect(seniorLow?.amount).toBe(150);
    expect(seniorLow?.loans.map((l) => l.loanId).sort()).toEqual(["l1", "l2"]);

    const juniorHigh = segments.find((s) => s.tranche === "Junior" && s.riskTier === "High");
    expect(juniorHigh?.amount).toBe(75);
    expect(juniorHigh?.loans.map((l) => l.loanId)).toEqual(["l3"]);
  });

  it("returns an empty array for no loans", () => {
    expect(computeSegments([])).toEqual([]);
  });

  it("keeps every tranche/risk-tier combination distinct", () => {
    const loans = [
      loan({ loanId: "l1", tranche: "Senior", riskTier: "Low", allocatedAmount: 10 }),
      loan({ loanId: "l2", tranche: "Senior", riskTier: "Medium", allocatedAmount: 20 }),
      loan({ loanId: "l3", tranche: "Senior", riskTier: "High", allocatedAmount: 30 }),
      loan({ loanId: "l4", tranche: "Junior", riskTier: "Low", allocatedAmount: 40 }),
      loan({ loanId: "l5", tranche: "Junior", riskTier: "Medium", allocatedAmount: 50 }),
      loan({ loanId: "l6", tranche: "Junior", riskTier: "High", allocatedAmount: 60 }),
    ];

    const segments = computeSegments(loans);
    expect(segments).toHaveLength(6);
  });

  describe("exact-sum guarantee", () => {
    it("sums segment totals back to the exact sum of input allocations for round numbers", () => {
      const loans = [
        loan({ loanId: "l1", allocatedAmount: 1234.56 }),
        loan({ loanId: "l2", tranche: "Junior", riskTier: "High", allocatedAmount: 8765.44 }),
      ];

      const segments = computeSegments(loans);
      expect(sumSegments(segments)).toBe(sumAllocations(loans));
      expect(sumSegments(segments)).toBe(10000);
    });

    it("stays exact for many loans with amounts prone to floating-point drift", () => {
      // 0.1 + 0.2 !== 0.3 in IEEE-754 — this is exactly the kind of input that
      // breaks naive floating-point accumulation.
      const loans: LoanAllocation[] = [];
      for (let i = 0; i < 50; i++) {
        loans.push(
          loan({
            loanId: `l${i}`,
            tranche: i % 2 === 0 ? "Senior" : "Junior",
            riskTier: i % 3 === 0 ? "Low" : i % 3 === 1 ? "Medium" : "High",
            allocatedAmount: 0.1 + i * 0.01,
          })
        );
      }

      const segments = computeSegments(loans);
      const expectedTotalCents = loans.reduce(
        (cents, l) => cents + Math.round(l.allocatedAmount * 100),
        0
      );

      expect(Math.round(sumSegments(segments) * 100)).toBe(expectedTotalCents);
      expect(Math.round(sumAllocations(loans) * 100)).toBe(expectedTotalCents);
      expect(sumSegments(segments)).toBe(sumAllocations(loans));
    });

    it("matches a caller-supplied total deposited figure exactly", () => {
      const totalDeposited = 30000;
      const loans = [
        loan({ loanId: "l1", tranche: "Senior", riskTier: "Low", allocatedAmount: 10000.33 }),
        loan({ loanId: "l2", tranche: "Senior", riskTier: "Medium", allocatedAmount: 9999.67 }),
        loan({ loanId: "l3", tranche: "Junior", riskTier: "High", allocatedAmount: 10000 }),
      ];

      const segments = computeSegments(loans);
      expect(sumSegments(segments)).toBe(totalDeposited);
    });
  });
});

describe("loansForSegment", () => {
  it("returns the loans backing the requested tranche/risk-tier segment", () => {
    const loans = [
      loan({ loanId: "l1", tranche: "Senior", riskTier: "Low" }),
      loan({ loanId: "l2", tranche: "Junior", riskTier: "High" }),
      loan({ loanId: "l3", tranche: "Junior", riskTier: "High" }),
    ];
    const segments = computeSegments(loans);

    expect(loansForSegment(segments, "Junior", "High").map((l) => l.loanId).sort()).toEqual([
      "l2",
      "l3",
    ]);
    expect(loansForSegment(segments, "Senior", "Low").map((l) => l.loanId)).toEqual(["l1"]);
  });

  it("returns an empty array when no loans back that segment", () => {
    const segments = computeSegments([loan({ tranche: "Senior", riskTier: "Low" })]);
    expect(loansForSegment(segments, "Junior", "Medium")).toEqual([]);
  });
});

describe("segmentKey", () => {
  it("produces a stable, distinct key per tranche/risk-tier pair", () => {
    expect(segmentKey("Senior", "Low")).toBe("Senior:Low");
    expect(segmentKey("Senior", "Low")).not.toBe(segmentKey("Junior", "Low"));
    expect(segmentKey("Senior", "Low")).not.toBe(segmentKey("Senior", "Medium"));
  });
});
