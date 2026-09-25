// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  BPS_SCALE,
  buildAmortizationSchedule,
  calculateMonthlyPayment,
  calculateTotalInterest,
  formatRateBps,
  formatStroops,
  STROOPS_PER_UNIT,
  toStroops,
} from "../amortization";

/** 10,000 USDC in stroops — the figure used across the contract's own tests. */
const PRINCIPAL = 10_000n * STROOPS_PER_UNIT;

describe("calculateTotalInterest", () => {
  it("applies flat interest exactly as approve_loan does", () => {
    // Contract: interest = principal * interest_rate_bps / 10_000
    expect(calculateTotalInterest(PRINCIPAL, 800)).toBe(
      (PRINCIPAL * 800n) / BPS_SCALE
    );
    expect(calculateTotalInterest(PRINCIPAL, 800)).toBe(800n * STROOPS_PER_UNIT);
  });

  it("floors rather than rounding, matching integer division on-chain", () => {
    // 3 stroops at 1 bps => 0.0003 stroops, floors to 0.
    expect(calculateTotalInterest(3n, 1)).toBe(0n);
  });

  it("returns zero for non-positive principal or rate", () => {
    expect(calculateTotalInterest(0n, 800)).toBe(0n);
    expect(calculateTotalInterest(PRINCIPAL, 0)).toBe(0n);
    expect(calculateTotalInterest(-PRINCIPAL, 800)).toBe(0n);
  });
});

describe("calculateMonthlyPayment", () => {
  it("matches the contract's monthly_amount", () => {
    // total_owed / duration_months, floored.
    const totalOwed = PRINCIPAL + 800n * STROOPS_PER_UNIT;
    expect(calculateMonthlyPayment(PRINCIPAL, 800, 12)).toBe(totalOwed / 12n);
  });

  it("returns zero when the term is empty", () => {
    expect(calculateMonthlyPayment(PRINCIPAL, 800, 0)).toBe(0n);
  });
});

describe("buildAmortizationSchedule", () => {
  it("emits one row per month", () => {
    const { rows } = buildAmortizationSchedule({
      principal: PRINCIPAL,
      interestRateBps: 800,
      durationMonths: 12,
    });

    expect(rows).toHaveLength(12);
    expect(rows[0].month).toBe(1);
    expect(rows[11].month).toBe(12);
  });

  it("splits every installment into principal and interest that sum to the payment", () => {
    const { rows } = buildAmortizationSchedule({
      principal: PRINCIPAL,
      interestRateBps: 800,
      durationMonths: 12,
    });

    for (const row of rows) {
      expect(row.principal + row.interest).toBe(row.payment);
    }
  });

  it("closes out at exactly the total owed, with rounding dust on the last row", () => {
    // 7 months over a principal that does not divide evenly forces a remainder.
    const principal = 10_000n * STROOPS_PER_UNIT + 3n;
    const { rows, summary } = buildAmortizationSchedule({
      principal,
      interestRateBps: 850,
      durationMonths: 7,
    });

    const paymentSum = rows.reduce((total, row) => total + row.payment, 0n);
    const principalSum = rows.reduce((total, row) => total + row.principal, 0n);
    const interestSum = rows.reduce((total, row) => total + row.interest, 0n);

    expect(paymentSum).toBe(summary.totalRepayment);
    expect(principalSum).toBe(principal);
    expect(interestSum).toBe(summary.totalInterest);
    expect(rows[rows.length - 1].remainingBalance).toBe(0n);
    expect(rows[rows.length - 1].remainingPrincipal).toBe(0n);
  });

  it("drives the balance monotonically down to zero", () => {
    const { rows } = buildAmortizationSchedule({
      principal: PRINCIPAL,
      interestRateBps: 1200,
      durationMonths: 24,
    });

    rows.forEach((row, index) => {
      if (index > 0) {
        expect(row.remainingBalance).toBeLessThan(rows[index - 1].remainingBalance);
      }
    });
    expect(rows[rows.length - 1].remainingBalance).toBe(0n);
  });

  it("accumulates interest across rows", () => {
    const { rows, summary } = buildAmortizationSchedule({
      principal: PRINCIPAL,
      interestRateBps: 600,
      durationMonths: 12,
    });

    expect(rows[0].cumulativeInterest).toBe(rows[0].interest);
    expect(rows[11].cumulativeInterest).toBe(summary.totalInterest);
  });

  it("marks installments paid, due and upcoming from payments_made", () => {
    const { rows, summary } = buildAmortizationSchedule({
      principal: PRINCIPAL,
      interestRateBps: 800,
      durationMonths: 12,
      paymentsMade: 3,
    });

    expect(rows.slice(0, 3).every((row) => row.status === "paid")).toBe(true);
    expect(rows[3].status).toBe("due");
    expect(rows.slice(4).every((row) => row.status === "upcoming")).toBe(true);

    const expectedPaid = rows.slice(0, 3).reduce((t, r) => t + r.payment, 0n);
    expect(summary.amountPaid).toBe(expectedPaid);
    expect(summary.amountRemaining).toBe(summary.totalRepayment - expectedPaid);
  });

  it("reacts to a changed term without altering the flat interest total", () => {
    const short = buildAmortizationSchedule({
      principal: PRINCIPAL,
      interestRateBps: 800,
      durationMonths: 6,
    });
    const long = buildAmortizationSchedule({
      principal: PRINCIPAL,
      interestRateBps: 800,
      durationMonths: 24,
    });

    // Flat interest is term-independent on-chain — only the split changes.
    expect(short.summary.totalInterest).toBe(long.summary.totalInterest);
    expect(short.summary.monthlyPayment).toBeGreaterThan(
      long.summary.monthlyPayment
    );
  });

  it("returns an empty schedule for a zero principal or zero term", () => {
    expect(
      buildAmortizationSchedule({
        principal: 0n,
        interestRateBps: 800,
        durationMonths: 12,
      }).rows
    ).toHaveLength(0);

    expect(
      buildAmortizationSchedule({
        principal: PRINCIPAL,
        interestRateBps: 800,
        durationMonths: 0,
      }).rows
    ).toHaveLength(0);
  });
});

describe("formatting helpers", () => {
  it("formats stroops without losing precision on large balances", () => {
    expect(formatStroops(1_234_567n * STROOPS_PER_UNIT)).toBe("1,234,567.00");
    expect(formatStroops(15_000_000n)).toBe("1.50");
    expect(formatStroops(-15_000_000n)).toBe("-1.50");
    expect(formatStroops(15_000_000n, 0)).toBe("1");
  });

  it("round-trips whole token amounts to stroops", () => {
    expect(toStroops(1.5)).toBe(15_000_000n);
    expect(toStroops(0)).toBe(0n);
    expect(toStroops(-5)).toBe(0n);
    expect(toStroops(Number.NaN)).toBe(0n);
  });

  it("renders basis points as a percentage", () => {
    expect(formatRateBps(800)).toBe("8.00%");
    expect(formatRateBps(1225)).toBe("12.25%");
  });
});
