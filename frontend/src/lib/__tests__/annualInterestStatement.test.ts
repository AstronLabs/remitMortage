// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  buildAnnualInterestStatement,
  buildAnnualInterestStatementPayload,
  parseTokenAmount,
  repaymentYear,
  type AnnualRepayment,
} from "../annualInterestStatement";
import { STROOPS_PER_UNIT, formatStroops } from "../amortization";

/** 1,200.00 USDC paid monthly; 1,120.00 principal + 80.00 interest. */
function loanARepayment(index: number, year: number): AnnualRepayment {
  const month = String(index + 1).padStart(2, "0");
  return {
    id: `loan-a-${year}-${index + 1}`,
    loanId: "LOAN-A",
    loanName: "Home Construction Loan",
    date: `${year}-${month}-05T09:00:00Z`,
    amount: parseTokenAmount("1200.00"),
    principal: parseTokenAmount("1120.00"),
    interest: parseTokenAmount("80.00"),
  };
}

/** 850.00 USDC quarterly; 800.00 principal + 50.00 interest. */
function loanBRepayment(index: number, year: number, monthDay: string): AnnualRepayment {
  return {
    id: `loan-b-${year}-${index + 1}`,
    loanId: "LOAN-B",
    loanName: "Renovation Loan",
    date: `${year}-${monthDay}T11:15:00Z`,
    amount: parseTokenAmount("850.00"),
    principal: parseTokenAmount("800.00"),
    interest: parseTokenAmount("50.00"),
  };
}

const FULL_YEAR_2025: AnnualRepayment[] = [
  ...Array.from({ length: 12 }, (_, index) => loanARepayment(index, 2025)),
  ...["01-01", "04-20", "07-20", "10-20"].map((monthDay, index) =>
    loanBRepayment(index, 2025, monthDay)
  ),
];

describe("parseTokenAmount", () => {
  it("parses whole and fractional USDC into stroops", () => {
    expect(parseTokenAmount("1200.00")).toBe(1200n * STROOPS_PER_UNIT);
    expect(parseTokenAmount("0")).toBe(0n);
    expect(parseTokenAmount("1.5")).toBe(15_000_000n);
    expect(parseTokenAmount(".5")).toBe(5_000_000n);
    expect(parseTokenAmount(42)).toBe(420_000_000n);
  });

  it("truncates beyond Stellar's 7 decimal places", () => {
    expect(parseTokenAmount("100.12345678")).toBe(100_123_4567n);
  });

  it("supports negative amounts and rejects malformed input", () => {
    expect(parseTokenAmount("-1.5")).toBe(-15_000_000n);
    expect(parseTokenAmount("abc")).toBe(0n);
    expect(parseTokenAmount("")).toBe(0n);
    expect(parseTokenAmount("1.2.3")).toBe(0n);
  });
});

describe("repaymentYear", () => {
  it("reads the UTC calendar year", () => {
    expect(repaymentYear("2025-12-31T23:59:59Z")).toBe(2025);
    expect(repaymentYear("2026-01-01T00:00:00Z")).toBe(2026);
  });
});

describe("buildAnnualInterestStatement", () => {
  it("sums interest across a full year of repayments (acceptance)", () => {
    const statement = buildAnnualInterestStatement(FULL_YEAR_2025, 2025);

    const expectedInterest = FULL_YEAR_2025.reduce(
      (total, repayment) => total + repayment.interest,
      0n
    );
    const expectedPrincipal = FULL_YEAR_2025.reduce(
      (total, repayment) => total + repayment.principal,
      0n
    );

    expect(statement.combined.interestPaid).toBe(expectedInterest);
    expect(statement.combined.principalPaid).toBe(expectedPrincipal);
    expect(statement.combined.interestPaid).toBe(960n * STROOPS_PER_UNIT + 200n * STROOPS_PER_UNIT);
    expect(statement.combined.totalPaid).toBe(17_800n * STROOPS_PER_UNIT);
  });

  it("reports per-loan and combined totals for multiple loans (acceptance)", () => {
    const statement = buildAnnualInterestStatement(FULL_YEAR_2025, 2025);

    expect(statement.loans).toHaveLength(2);
    expect(statement.combined.loanCount).toBe(2);

    const home = statement.loans.find((loan) => loan.loanId === "LOAN-A")!;
    const renovation = statement.loans.find((loan) => loan.loanId === "LOAN-B")!;

    expect(home.principalPaid).toBe(13_440n * STROOPS_PER_UNIT);
    expect(home.interestPaid).toBe(960n * STROOPS_PER_UNIT);
    expect(home.repaymentCount).toBe(12);

    expect(renovation.principalPaid).toBe(3_200n * STROOPS_PER_UNIT);
    expect(renovation.interestPaid).toBe(200n * STROOPS_PER_UNIT);
    expect(renovation.repaymentCount).toBe(4);

    // Combined is exactly the sum of the per-loan rows.
    expect(statement.combined.principalPaid).toBe(
      home.principalPaid + renovation.principalPaid
    );
    expect(statement.combined.interestPaid).toBe(
      home.interestPaid + renovation.interestPaid
    );
    expect(statement.combined.totalPaid).toBe(home.totalPaid + renovation.totalPaid);
    expect(statement.combined.repaymentCount).toBe(
      home.repaymentCount + renovation.repaymentCount
    );
  });

  it("filters repayments to the selected calendar year", () => {
    const withNeighbourYears: AnnualRepayment[] = [
      ...FULL_YEAR_2025,
      loanARepayment(0, 2024),
      loanBRepayment(0, 2026, "01-01"),
    ];

    const statement2025 = buildAnnualInterestStatement(withNeighbourYears, 2025);
    expect(statement2025.combined.repaymentCount).toBe(16);
    expect(statement2025.repayments.every((r) => repaymentYear(r.date) === 2025)).toBe(true);

    const statement2026 = buildAnnualInterestStatement(withNeighbourYears, 2026);
    expect(statement2026.combined.repaymentCount).toBe(1);
    expect(statement2026.combined.interestPaid).toBe(50n * STROOPS_PER_UNIT);
    expect(statement2026.loans).toHaveLength(1);
    expect(statement2026.loans[0].loanId).toBe("LOAN-B");
  });

  it("treats a Dec 31 repayment as the current year and Jan 1 as the next", () => {
    const boundary: AnnualRepayment[] = [
      {
        ...loanBRepayment(0, 2025, "12-31"),
        date: "2025-12-31T23:30:00Z",
      },
      {
        ...loanBRepayment(1, 2026, "01-01"),
        date: "2026-01-01T00:00:00Z",
      },
    ];

    const statement2025 = buildAnnualInterestStatement(boundary, 2025);
    expect(statement2025.repayments).toHaveLength(1);
    expect(statement2025.repayments[0].date).toBe("2025-12-31T23:30:00Z");

    const statement2026 = buildAnnualInterestStatement(boundary, 2026);
    expect(statement2026.repayments).toHaveLength(1);
    expect(statement2026.repayments[0].date).toBe("2026-01-01T00:00:00Z");
  });

  it("returns chronological repayments and an empty result for years with no activity", () => {
    const reversed = [...FULL_YEAR_2025].reverse();
    const statement = buildAnnualInterestStatement(reversed, 2025);

    const ordered = statement.repayments.map((repayment) => repayment.date);
    expect(ordered).toEqual([...ordered].sort());

    const empty = buildAnnualInterestStatement(FULL_YEAR_2025, 2019);
    expect(empty.repayments).toHaveLength(0);
    expect(empty.loans).toHaveLength(0);
    expect(empty.combined).toEqual({
      principalPaid: 0n,
      interestPaid: 0n,
      totalPaid: 0n,
      repaymentCount: 0,
      loanCount: 0,
    });
  });
});

describe("buildAnnualInterestStatementPayload", () => {
  const metadata = {
    borrowerName: "Wallet GABC…WXYZ",
    borrowerAddress: "GABCWXYZDEFAKEKEY1234567890",
    walletType: "Freighter / Stellar",
    generatedAt: "2026-01-01T00:00:00Z",
  };

  it("carries combined and per-loan figures into the export payload", () => {
    const statement = buildAnnualInterestStatement(FULL_YEAR_2025, 2025);
    const payload = buildAnnualInterestStatementPayload(statement, metadata);

    expect(payload.title).toContain("2025");

    const combinedInterest = payload.summary.find(
      (item) => item.label === "Combined Interest Paid"
    );
    expect(combinedInterest?.value).toBe(formatStroops(statement.combined.interestPaid) + " USDC");

    expect(
      payload.summary.some((item) => item.label === "Home Construction Loan — Interest")
    ).toBe(true);
    expect(
      payload.summary.some((item) => item.label === "Renovation Loan — Interest")
    ).toBe(true);

    const perLoanRows = payload.rows.filter((row) => row.type === "Loan Annual Total");
    expect(perLoanRows).toHaveLength(statement.loans.length);

    const repaymentRows = payload.rows.filter((row) => row.type === "Repayment");
    expect(repaymentRows).toHaveLength(statement.repayments.length);
    expect(payload.rows).toHaveLength(statement.loans.length + statement.repayments.length);
  });

  it("keeps each repayment's split in the row notes", () => {
    const statement = buildAnnualInterestStatement([loanARepayment(0, 2025)], 2025);
    const payload = buildAnnualInterestStatementPayload(statement, metadata);

    const repaymentRow = payload.rows.find((row) => row.type === "Repayment")!;
    expect(repaymentRow.notes).toContain(formatStroops(parseTokenAmount("1120.00")));
    expect(repaymentRow.notes).toContain(formatStroops(parseTokenAmount("80.00")));
  });
});
