import {
  computeOverview,
  computeLoanPerformance,
  computeDisbursementProgress,
  computeMonthlyVolume,
  getProtocolOverview,
  clearAnalyticsCache,
  type ProtocolSnapshot,
  type AnalyticsLoan,
  type VolumeEvent,
} from "../services/analytics";

const EMPTY_SNAPSHOT: ProtocolSnapshot = {
  loans: [],
  balances: [],
  milestones: [],
  investorCount: 0,
  defaultedLoans: 0,
  onTimePayments: 0,
  totalScheduledPayments: 0,
  volumeEvents: [],
};

function loan(partial: Partial<AnalyticsLoan>): AnalyticsLoan {
  return {
    borrowerAddress: "GBORROWER1",
    status: "Pending",
    amount: "1000",
    createdAt: "2026-01-15T00:00:00.000Z",
    ...partial,
  };
}

beforeEach(() => {
  clearAnalyticsCache();
});

describe("computeOverview", () => {
  it("returns zeroed metrics for an empty protocol", () => {
    const overview = computeOverview(EMPTY_SNAPSHOT);
    expect(overview).toEqual({
      tvl: { escrow: "0", lendingPool: "0", total: "0" },
      totalBorrowers: 0,
      totalInvestors: 0,
      totalLoans: 0,
    });
  });

  it("sums TVL and counts distinct borrowers", () => {
    const overview = computeOverview({
      ...EMPTY_SNAPSHOT,
      balances: [
        { address: "GA", escrowBalance: "1000000000", loanOutstanding: "500000000" },
        { address: "GB", escrowBalance: "2000000000", loanOutstanding: "0" },
      ],
      loans: [
        loan({ borrowerAddress: "GA" }),
        loan({ borrowerAddress: "GC" }), // GC has no balance row
      ],
      investorCount: 4,
    });

    // escrow 3,000,000,000 + lending pool 500,000,000 = 3,500,000,000.
    expect(overview.tvl).toEqual({
      escrow: "3000000000",
      lendingPool: "500000000",
      total: "3500000000",
    });
    // Distinct borrowers: GA, GB (balance), GC (loan).
    expect(overview.totalBorrowers).toBe(3);
    expect(overview.totalInvestors).toBe(4);
    expect(overview.totalLoans).toBe(2);
  });
});

describe("computeLoanPerformance", () => {
  it("computes repayment and default rates", () => {
    const perf = computeLoanPerformance({
      ...EMPTY_SNAPSHOT,
      loans: [
        loan({ status: "Repaying" }),
        loan({ status: "Disbursing" }),
        loan({ status: "Completed" }),
        loan({ status: "Completed" }),
        loan({ status: "Completed" }),
        loan({ status: "Pending" }),
      ],
      defaultedLoans: 1,
      onTimePayments: 8,
      totalScheduledPayments: 10,
    });

    expect(perf.activeLoans).toBe(2); // Repaying + Disbursing
    expect(perf.repaidLoans).toBe(3); // Completed x3
    expect(perf.defaultedLoans).toBe(1);
    expect(perf.totalLoans).toBe(6);
    // Concluded = 3 repaid + 1 defaulted = 4 → 75% repaid, 25% default.
    expect(perf.repaymentRate).toBe(75);
    expect(perf.defaultRate).toBe(25);
    expect(perf.onTimePaymentPercentage).toBe(80);
  });

  it("returns zero rates with no concluded loans", () => {
    const perf = computeLoanPerformance(EMPTY_SNAPSHOT);
    expect(perf.repaymentRate).toBe(0);
    expect(perf.defaultRate).toBe(0);
    expect(perf.onTimePaymentPercentage).toBe(0);
  });
});

describe("computeDisbursementProgress", () => {
  it("counts milestones and averages completion time", () => {
    const progress = computeDisbursementProgress({
      ...EMPTY_SNAPSHOT,
      balances: [
        { address: "GA", escrowBalance: "0", loanOutstanding: "700000000" },
      ],
      milestones: [
        {
          status: "Passed",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-03T00:00:00.000Z", // 2 days
        },
        {
          status: "Passed",
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-05T00:00:00.000Z", // 4 days
        },
        { status: "Open", createdAt: "2026-03-01T00:00:00.000Z", updatedAt: "2026-03-01T00:00:00.000Z" },
        { status: "Rejected", createdAt: "2026-03-01T00:00:00.000Z", updatedAt: "2026-03-02T00:00:00.000Z" },
      ],
    });

    const threeDaysMs = 3 * 24 * 60 * 60 * 1000; // average of 2 and 4 days
    expect(progress.totalDisbursed).toBe("700000000");
    expect(progress.milestonesCompleted).toBe(2);
    expect(progress.milestonesPending).toBe(1);
    expect(progress.averageMilestoneCompletionMs).toBe(threeDaysMs);
  });
});

describe("computeMonthlyVolume", () => {
  const now = new Date("2026-06-15T00:00:00.000Z");

  it("buckets events into the requested trailing months", () => {
    const events: VolumeEvent[] = [
      { kind: "deposit", amount: "100", timestamp: "2026-06-02T00:00:00.000Z" },
      { kind: "deposit", amount: "50", timestamp: "2026-06-20T00:00:00.000Z" },
      { kind: "repayment", amount: "40", timestamp: "2026-05-10T00:00:00.000Z" },
      { kind: "disbursement", amount: "900", timestamp: "2026-04-10T00:00:00.000Z" },
      // Outside the 3-month window — must be ignored.
      { kind: "deposit", amount: "999", timestamp: "2026-01-01T00:00:00.000Z" },
    ];

    const series = computeMonthlyVolume(events, 3, now);

    expect(series.map((p) => p.month)).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(series[0]).toEqual({ month: "2026-04", deposits: "0", repayments: "0", disbursements: "900" });
    expect(series[1]).toEqual({ month: "2026-05", deposits: "0", repayments: "40", disbursements: "0" });
    expect(series[2]).toEqual({ month: "2026-06", deposits: "150", repayments: "0", disbursements: "0" });
  });

  it("returns zeroed buckets for the full period when there are no events", () => {
    const series = computeMonthlyVolume([], 6, now);
    expect(series).toHaveLength(6);
    expect(series.every((p) => p.deposits === "0" && p.repayments === "0" && p.disbursements === "0")).toBe(true);
    expect(series[5].month).toBe("2026-06");
  });

  it("clamps the month count to the 1-24 range", () => {
    expect(computeMonthlyVolume([], 100, now)).toHaveLength(24);
    expect(computeMonthlyVolume([], 0, now)).toHaveLength(1);
  });
});

describe("getProtocolOverview caching", () => {
  it("computes once and serves cached results within the TTL", () => {
    let calls = 0;
    const listLoans = () => {
      calls += 1;
      return [loan({ borrowerAddress: "GA", status: "Completed" })];
    };

    const first = getProtocolOverview({ listLoans, listBalances: () => [], listMilestones: () => [] });
    const second = getProtocolOverview({ listLoans, listBalances: () => [], listMilestones: () => [] });

    expect(second).toEqual(first);
    expect(calls).toBe(1); // second call hit the cache
  });
});
