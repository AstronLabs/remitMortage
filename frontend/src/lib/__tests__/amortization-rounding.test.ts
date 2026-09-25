// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  BPS_SCALE,
  buildAmortizationSchedule,
  calculateMonthlyPayment,
  calculateTotalInterest,
  STROOPS_PER_UNIT,
  type AmortizationSchedule,
} from "../amortization";

/**
 * Rounding regression suite for the amortization schedule.
 *
 * The schedule is built from integer (stroop) arithmetic with floor division,
 * mirroring `approve_loan` on-chain. Floor division sheds a remainder at every
 * step, and the danger is that the shed dust either goes missing or is counted
 * twice — a borrower shown a schedule that does not add up to what they owe.
 *
 * Every case here asserts *exact* reconciliation. There is no tolerance
 * parameter anywhere in this file on purpose: with integer arithmetic the
 * correct residual drift is zero, and a test that tolerates "close enough"
 * would not catch the bug it exists to catch.
 *
 * The three invariants under test:
 *
 *   1. Per row      — `principal + interest === payment`
 *   2. Per column   — the sums of payment / principal / interest each equal
 *                     `totalRepayment` / `principal` / `totalInterest`
 *   3. Final row    — absorbs the entire accumulated remainder, and only the
 *                     final row deviates from the level installment
 */

/** Terms chosen so `total_owed / duration` recurs rather than divides evenly. */
const REPEATING_DECIMAL_TERMS = [7, 9, 11, 13, 14, 17, 19, 21, 23, 29, 31, 37];

/** Principals that are deliberately not round numbers of stroops. */
const AWKWARD_PRINCIPALS = [
  1n, // one stroop — the smallest loan expressible
  3n,
  7n,
  99n,
  1_000n * STROOPS_PER_UNIT + 1n,
  10_000n * STROOPS_PER_UNIT + 3n,
  33_333n * STROOPS_PER_UNIT + 7n,
  123_456_789n,
  999_999_999_999n,
];

/** Rates that produce a non-terminating interest slice. */
const AWKWARD_RATES = [1, 7, 33, 137, 350, 799, 800, 1_234, 9_999];

interface Reconciliation {
  paymentSum: bigint;
  principalSum: bigint;
  interestSum: bigint;
}

function reconcile(schedule: AmortizationSchedule): Reconciliation {
  return schedule.rows.reduce<Reconciliation>(
    (acc, row) => ({
      paymentSum: acc.paymentSum + row.payment,
      principalSum: acc.principalSum + row.principal,
      interestSum: acc.interestSum + row.interest,
    }),
    { paymentSum: 0n, principalSum: 0n, interestSum: 0n }
  );
}

/**
 * Asserts every reconciliation invariant for one schedule. Used by the matrix
 * cases below so a failure names the exact principal/rate/term combination.
 */
function expectExactReconciliation(
  principal: bigint,
  interestRateBps: number,
  durationMonths: number
): AmortizationSchedule {
  const schedule = buildAmortizationSchedule({
    principal,
    interestRateBps,
    durationMonths,
  });
  const { rows, summary } = schedule;
  const { paymentSum, principalSum, interestSum } = reconcile(schedule);

  // 2. Column sums reconcile with zero residual drift.
  expect(paymentSum).toBe(summary.totalRepayment);
  expect(principalSum).toBe(principal);
  expect(interestSum).toBe(summary.totalInterest);
  expect(paymentSum - principalSum - interestSum).toBe(0n);

  // 1. Every row is internally consistent.
  for (const row of rows) {
    expect(row.principal + row.interest).toBe(row.payment);
  }

  // The schedule fully retires the debt.
  expect(rows[rows.length - 1].remainingPrincipal).toBe(0n);
  expect(rows[rows.length - 1].remainingBalance).toBe(0n);
  expect(rows[rows.length - 1].cumulativeInterest).toBe(summary.totalInterest);

  return schedule;
}

describe("odd-term lengths that produce repeating decimals", () => {
  const principal = 10_000n * STROOPS_PER_UNIT;

  it.each(REPEATING_DECIMAL_TERMS)(
    "reconciles exactly over a %i-month term",
    (durationMonths) => {
      expectExactReconciliation(principal, 800, durationMonths);
    }
  );

  it("covers terms that genuinely do not divide evenly", () => {
    // Guards the fixtures themselves: if every term above divided cleanly the
    // suite would pass without ever exercising the remainder path.
    const withRemainder = REPEATING_DECIMAL_TERMS.filter((months) => {
      const total = principal + calculateTotalInterest(principal, 800);
      return total % BigInt(months) !== 0n;
    });

    expect(withRemainder.length).toBeGreaterThan(0);
  });

  it("keeps the level installment on every row but the last", () => {
    const { rows, summary } = buildAmortizationSchedule({
      principal,
      interestRateBps: 800,
      durationMonths: 7,
    });

    for (const row of rows.slice(0, -1)) {
      expect(row.payment).toBe(summary.monthlyPayment);
    }

    // 3. Only the final row deviates, and it deviates by exactly the remainder.
    const remainder = summary.totalRepayment % 7n;
    expect(rows[rows.length - 1].payment).toBe(summary.monthlyPayment + remainder);
  });
});

describe("fractional-cent principals and rates", () => {
  it.each(AWKWARD_PRINCIPALS)(
    "reconciles exactly for a principal of %s stroops",
    (principal) => {
      expectExactReconciliation(principal, 837, 12);
    }
  );

  it.each(AWKWARD_RATES)("reconciles exactly at %i bps", (interestRateBps) => {
    expectExactReconciliation(10_000n * STROOPS_PER_UNIT + 3n, interestRateBps, 11);
  });

  it("reconciles across the full principal x rate x term matrix", () => {
    // The individual cases above vary one axis at a time; drift can also come
    // from an interaction, so sweep the product too.
    for (const principal of AWKWARD_PRINCIPALS) {
      for (const interestRateBps of AWKWARD_RATES) {
        for (const durationMonths of REPEATING_DECIMAL_TERMS) {
          const schedule = buildAmortizationSchedule({
            principal,
            interestRateBps,
            durationMonths,
          });
          const { paymentSum, principalSum, interestSum } = reconcile(schedule);

          // Reported inline so a failure names the offending combination.
          expect({
            principal,
            interestRateBps,
            durationMonths,
            paymentSum,
            principalSum,
            interestSum,
          }).toEqual({
            principal,
            interestRateBps,
            durationMonths,
            paymentSum: schedule.summary.totalRepayment,
            principalSum: principal,
            interestSum: schedule.summary.totalInterest,
          });
        }
      }
    }
  });
});

describe("final-payment absorption of the accumulated remainder", () => {
  it("puts the whole payment remainder on the final installment", () => {
    const principal = 10_000n * STROOPS_PER_UNIT + 3n;
    const durationMonths = 7;
    const { rows, summary } = buildAmortizationSchedule({
      principal,
      interestRateBps: 850,
      durationMonths,
    });

    const remainder = summary.totalRepayment % BigInt(durationMonths);
    expect(remainder).toBeGreaterThan(0n);

    const final = rows[rows.length - 1];
    expect(final.payment - summary.monthlyPayment).toBe(remainder);
  });

  it("puts the whole interest remainder on the final installment", () => {
    const principal = 10_000n * STROOPS_PER_UNIT + 3n;
    const durationMonths = 7;
    const { rows, summary } = buildAmortizationSchedule({
      principal,
      interestRateBps: 850,
      durationMonths,
    });

    const perMonthInterest = summary.totalInterest / BigInt(durationMonths);
    const interestRemainder = summary.totalInterest % BigInt(durationMonths);

    for (const row of rows.slice(0, -1)) {
      expect(row.interest).toBe(perMonthInterest);
    }
    expect(rows[rows.length - 1].interest).toBe(perMonthInterest + interestRemainder);
  });

  it("absorbs everything on the single installment of a one-month term", () => {
    const principal = 7_777n * STROOPS_PER_UNIT + 7n;
    const { rows, summary } = buildAmortizationSchedule({
      principal,
      interestRateBps: 913,
      durationMonths: 1,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].payment).toBe(summary.totalRepayment);
    expect(rows[0].principal).toBe(principal);
    expect(rows[0].interest).toBe(summary.totalInterest);
  });

  it("never lets the remainder reach a second row", () => {
    // Every non-final row must be identical; any drift leaking backwards
    // would show up as a row that differs from its neighbour.
    const { rows } = buildAmortizationSchedule({
      principal: 12_345n * STROOPS_PER_UNIT + 6n,
      interestRateBps: 777,
      durationMonths: 23,
    });

    const head = rows.slice(0, -1);
    for (const row of head) {
      expect(row.payment).toBe(head[0].payment);
      expect(row.principal).toBe(head[0].principal);
      expect(row.interest).toBe(head[0].interest);
    }
  });

  it("keeps the final adjustment bounded by the term length", () => {
    // The remainder of a floor division is always < the divisor, so the final
    // row can never differ from the level installment by a whole installment.
    for (const durationMonths of REPEATING_DECIMAL_TERMS) {
      const { rows, summary } = buildAmortizationSchedule({
        principal: 54_321n * STROOPS_PER_UNIT + 9n,
        interestRateBps: 641,
        durationMonths,
      });

      const excess = rows[rows.length - 1].payment - summary.monthlyPayment;
      expect(excess).toBeGreaterThanOrEqual(0n);
      expect(excess).toBeLessThan(BigInt(durationMonths));
    }
  });
});

describe("no drift accumulates across the running balances", () => {
  it("decrements the remaining balance by exactly each payment", () => {
    const principal = 88_888n * STROOPS_PER_UNIT + 5n;
    const durationMonths = 19;
    const { rows, summary } = buildAmortizationSchedule({
      principal,
      interestRateBps: 431,
      durationMonths,
    });

    let expectedBalance = summary.totalRepayment;
    let expectedPrincipal = principal;
    let expectedInterest = 0n;

    for (const row of rows) {
      expectedBalance -= row.payment;
      expectedPrincipal -= row.principal;
      expectedInterest += row.interest;

      expect(row.remainingBalance).toBe(expectedBalance);
      expect(row.remainingPrincipal).toBe(expectedPrincipal);
      expect(row.cumulativeInterest).toBe(expectedInterest);
    }

    expect(expectedBalance).toBe(0n);
    expect(expectedPrincipal).toBe(0n);
    expect(expectedInterest).toBe(summary.totalInterest);
  });

  it("splits amountPaid and amountRemaining without losing a stroop", () => {
    const principal = 10_000n * STROOPS_PER_UNIT + 3n;
    const durationMonths = 13;

    for (let paymentsMade = 0; paymentsMade <= durationMonths; paymentsMade += 1) {
      const { summary } = buildAmortizationSchedule({
        principal,
        interestRateBps: 850,
        durationMonths,
        paymentsMade,
      });

      expect(summary.amountPaid + summary.amountRemaining).toBe(
        summary.totalRepayment
      );
    }
  });

  it("agrees with the standalone helpers on every fixture", () => {
    for (const principal of AWKWARD_PRINCIPALS) {
      for (const durationMonths of REPEATING_DECIMAL_TERMS) {
        const { summary } = buildAmortizationSchedule({
          principal,
          interestRateBps: 800,
          durationMonths,
        });

        expect(summary.totalInterest).toBe(calculateTotalInterest(principal, 800));
        expect(summary.monthlyPayment).toBe(
          calculateMonthlyPayment(principal, 800, durationMonths)
        );
      }
    }
  });
});

describe("parity with the on-chain schedule", () => {
  /** Recomputes `approve_loan`'s arithmetic directly from the contract formula. */
  function contractSchedule(principal: bigint, rateBps: number, months: number) {
    const interest = (principal * BigInt(rateBps)) / BPS_SCALE;
    const totalOwed = principal + interest;
    return { interest, totalOwed, monthlyAmount: totalOwed / BigInt(months) };
  }

  it.each(REPEATING_DECIMAL_TERMS)(
    "matches monthly_amount and total_owed over %i months",
    (months) => {
      const principal = 10_000n * STROOPS_PER_UNIT + 3n;
      const onChain = contractSchedule(principal, 850, months);
      const { summary } = buildAmortizationSchedule({
        principal,
        interestRateBps: 850,
        durationMonths: months,
      });

      expect(summary.totalInterest).toBe(onChain.interest);
      expect(summary.totalRepayment).toBe(onChain.totalOwed);
      expect(summary.monthlyPayment).toBe(onChain.monthlyAmount);
    }
  );

  it("recovers the remainder the contract's floor division discards", () => {
    // The contract stores only monthly_amount, so `monthly_amount * duration`
    // under-collects by the remainder. The schedule must still bill the full
    // total_owed, and the difference belongs on the final row.
    const principal = 10_000n * STROOPS_PER_UNIT + 3n;
    const months = 7;
    const onChain = contractSchedule(principal, 850, months);

    const naiveTotal = onChain.monthlyAmount * BigInt(months);
    const shortfall = onChain.totalOwed - naiveTotal;
    expect(shortfall).toBeGreaterThan(0n);

    const { rows, summary } = buildAmortizationSchedule({
      principal,
      interestRateBps: 850,
      durationMonths: months,
    });

    expect(reconcile({ rows, summary }).paymentSum).toBe(onChain.totalOwed);
    expect(rows[rows.length - 1].payment - onChain.monthlyAmount).toBe(shortfall);
  });
});
