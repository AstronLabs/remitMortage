// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  buildPortfolioDigestHtml,
  gatherPortfolioDigest,
  getConfiguredRecipients,
  getConfiguredSections,
  runAdminPortfolioDigestJob,
  ALL_SECTIONS,
} from "../jobs/adminPortfolioDigest";
import {
  getProtocolOverview,
  getLoanPerformance,
  getDisbursementProgress,
  clearAnalyticsCache,
  type AnalyticsDeps,
} from "../services/analytics";

// A fixed snapshot exercising every metric the digest renders.
const DEPS: AnalyticsDeps = {
  listBalances: () => [
    {
      address: "GBORROWER1",
      escrowBalance: "50000000000", // 5,000 USDC
      loanOutstanding: "30000000000", // 3,000 USDC
    },
  ],
  listLoans: () => [
    {
      borrowerAddress: "GBORROWER1",
      status: "Repaying",
      amount: "1000",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      borrowerAddress: "GBORROWER2",
      status: "Completed",
      amount: "2000",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      borrowerAddress: "GBORROWER3",
      status: "Approved",
      amount: "3000",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  listMilestones: () => [
    { status: "Passed", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
    { status: "Open", createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z" },
    { status: "Open", createdAt: "2026-01-04T00:00:00.000Z", updatedAt: "2026-01-04T00:00:00.000Z" },
  ],
  investorCount: 5,
  defaultedLoans: 1,
  onTimePayments: 8,
  totalScheduledPayments: 10,
  now: () => new Date("2026-02-01T00:00:00.000Z"),
};

beforeEach(() => {
  clearAnalyticsCache();
  delete process.env.ADMIN_DIGEST_RECIPIENTS;
  delete process.env.ADMIN_DIGEST_SECTIONS;
});

describe("gatherPortfolioDigest", () => {
  it("reads the same metrics the dashboard analytics endpoints serve", () => {
    const data = gatherPortfolioDigest(DEPS);
    clearAnalyticsCache();

    expect(data.overview).toEqual(getProtocolOverview(DEPS));
    expect(data.loans).toEqual(getLoanPerformance(DEPS));
    expect(data.disbursement).toEqual(getDisbursementProgress(DEPS));
  });
});

describe("buildPortfolioDigestHtml", () => {
  it("renders metric values that match the dashboard figures", () => {
    const data = gatherPortfolioDigest(DEPS);
    const html = buildPortfolioDigestHtml(data);

    // Overview — TVL total 8,000 USDC (5,000 escrow + 3,000 pool), counts.
    expect(html).toContain("$8,000.00 USDC");
    expect(html).toContain("$5,000.00 USDC");
    expect(html).toContain("$3,000.00 USDC");
    expect(html).toContain("Investors");

    // Loan performance — 2 active, 1 defaulted at 50% default rate, 80% on-time.
    expect(html).toContain("Active Loans");
    expect(html).toContain("<strong>2</strong>");
    expect(html).toContain("50%");
    expect(html).toContain("80%");

    // Disbursement — 1 completed, 2 pending reviews.
    expect(html).toContain("Pending Reviews");
    expect(html).toContain("Milestones Completed");
  });

  it("only includes the requested sections", () => {
    const data = gatherPortfolioDigest(DEPS);
    const html = buildPortfolioDigestHtml(data, ["overview"]);

    expect(html).toContain("Protocol Overview");
    expect(html).not.toContain("Loan Performance");
    expect(html).not.toContain("Disbursement");
  });
});

describe("runAdminPortfolioDigestJob", () => {
  it("dispatches the digest to every configured recipient", async () => {
    const sent: Array<{ to: string; subject: string }> = [];
    const result = await runAdminPortfolioDigestJob({
      recipients: ["admin1@example.com", "admin2@example.com"],
      deps: DEPS,
      send: async (to, subject) => {
        sent.push({ to, subject });
        return true;
      },
    });

    expect(result).toEqual({ sent: 2, failed: 0, recipients: 2 });
    expect(sent.map((s) => s.to)).toEqual([
      "admin1@example.com",
      "admin2@example.com",
    ]);
    expect(sent[0].subject).toContain("Portfolio Summary");
  });

  it("counts failed deliveries without throwing", async () => {
    const result = await runAdminPortfolioDigestJob({
      recipients: ["ok@example.com", "bad@example.com"],
      deps: DEPS,
      send: async (to) => to === "ok@example.com",
    });

    expect(result).toEqual({ sent: 1, failed: 1, recipients: 2 });
  });

  it("skips gracefully when no recipients are configured", async () => {
    let called = false;
    const result = await runAdminPortfolioDigestJob({
      recipients: [],
      deps: DEPS,
      send: async () => {
        called = true;
        return true;
      },
    });

    expect(result).toEqual({ sent: 0, failed: 0, recipients: 0 });
    expect(called).toBe(false);
  });
});

describe("digest configuration parsing", () => {
  it("parses comma-separated recipients from the environment", () => {
    process.env.ADMIN_DIGEST_RECIPIENTS = " a@example.com , b@example.com ,";
    expect(getConfiguredRecipients()).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("defaults to all sections when unset and validates configured sections", () => {
    expect(getConfiguredSections()).toEqual([...ALL_SECTIONS]);

    process.env.ADMIN_DIGEST_SECTIONS = "overview, bogus , loans";
    expect(getConfiguredSections()).toEqual(["overview", "loans"]);
  });
});
