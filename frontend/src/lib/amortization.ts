// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Loan amortization math, mirrored 1:1 against the LendingPool contract.
 *
 * `approve_loan` in `contracts/lending-pool/src/lib.rs` builds the on-chain
 * repayment schedule as:
 *
 *     interest       = principal * interest_rate_bps / 10_000   (integer floor)
 *     total_owed     = principal + interest
 *     monthly_amount = total_owed / duration_months             (integer floor)
 *
 * That is *flat* interest for the term — not a declining-balance annuity — so
 * the table below uses the same model. All arithmetic runs in bigint stroops
 * (1 USDC = 10,000,000 stroops) with floor division so the figures shown to the
 * borrower match the contract's schedule to the last stroop rather than drifting
 * by float rounding.
 *
 * Floor division leaves a remainder (`total_owed % duration_months`) that the
 * contract never spreads across installments; the borrower still owes it, so it
 * is attached to the final payment here.
 */

/** Stroops per whole token unit — Stellar assets carry 7 decimals. */
export const STROOPS_PER_UNIT = 10_000_000n;

/** Basis point scale (10,000 bps = 100%), matching `BPS_SCALE` on-chain. */
export const BPS_SCALE = 10_000n;

/** Term length the contract falls back to (`DEFAULT_DURATION_MONTHS`). */
export const DEFAULT_DURATION_MONTHS = 12;

/** Where a given installment sits relative to the borrower's progress. */
export type PaymentStatus = "paid" | "due" | "upcoming";

export interface AmortizationRow {
  /** 1-based installment number. */
  month: number;
  /** Total amount due for this installment, in stroops. */
  payment: bigint;
  /** Portion of the installment retiring principal, in stroops. */
  principal: bigint;
  /** Portion of the installment covering interest, in stroops. */
  interest: bigint;
  /** Principal still outstanding after this installment, in stroops. */
  remainingPrincipal: bigint;
  /** Total balance (principal + interest) still owed after this installment. */
  remainingBalance: bigint;
  /** Interest paid from the first installment through this one. */
  cumulativeInterest: bigint;
  /** Whether the borrower has settled, currently owes, or has yet to reach this row. */
  status: PaymentStatus;
}

export interface AmortizationSummary {
  /** Level installment the contract charges (final row may differ by the remainder). */
  monthlyPayment: bigint;
  /** Flat interest charged over the whole term. */
  totalInterest: bigint;
  /** Principal + interest. */
  totalRepayment: bigint;
  /** Sum of installments already marked paid. */
  amountPaid: bigint;
  /** Sum of installments still outstanding. */
  amountRemaining: bigint;
}

export interface AmortizationInput {
  /** Loan principal in stroops. */
  principal: bigint;
  /** Annual interest rate in basis points (e.g. 800 = 8%). */
  interestRateBps: number;
  /** Term in months. */
  durationMonths: number;
  /** Installments the borrower has already settled, from the on-chain schedule. */
  paymentsMade?: number;
}

export interface AmortizationSchedule {
  rows: AmortizationRow[];
  summary: AmortizationSummary;
}

/**
 * Flat interest for the term, floored exactly as the contract does.
 */
export function calculateTotalInterest(
  principal: bigint,
  interestRateBps: number
): bigint {
  if (principal <= 0n || interestRateBps <= 0) return 0n;
  return (principal * BigInt(Math.trunc(interestRateBps))) / BPS_SCALE;
}

/**
 * The level monthly installment the contract writes into `RepaymentSchedule`.
 */
export function calculateMonthlyPayment(
  principal: bigint,
  interestRateBps: number,
  durationMonths: number
): bigint {
  if (principal <= 0n || durationMonths <= 0) return 0n;
  const totalOwed = principal + calculateTotalInterest(principal, interestRateBps);
  return totalOwed / BigInt(Math.trunc(durationMonths));
}

/**
 * Builds the full month-by-month schedule.
 *
 * Each installment carries an equal slice of principal and of interest — the
 * consequence of flat interest — with all floor-division dust folded into the
 * final row so the rows sum back to the exact total owed.
 */
export function buildAmortizationSchedule({
  principal,
  interestRateBps,
  durationMonths,
  paymentsMade = 0,
}: AmortizationInput): AmortizationSchedule {
  const months = Math.max(0, Math.trunc(durationMonths));

  if (principal <= 0n || months === 0) {
    return {
      rows: [],
      summary: {
        monthlyPayment: 0n,
        totalInterest: 0n,
        totalRepayment: 0n,
        amountPaid: 0n,
        amountRemaining: 0n,
      },
    };
  }

  const termCount = BigInt(months);
  const totalInterest = calculateTotalInterest(principal, interestRateBps);
  const totalRepayment = principal + totalInterest;
  const monthlyPayment = totalRepayment / termCount;

  // Interest is floored per month; the principal slice is then whatever the
  // installment has left over. Flooring both independently does *not* work:
  // floor(principal/n) + floor(interest/n) can come to one stroop less than
  // floor((principal + interest)/n), which would leave every non-final row's
  // components failing to add up to its own payment. Deriving principal from
  // the payment keeps `principal + interest === payment` true on every row.
  const interestPerMonth = totalInterest / termCount;
  const principalPerMonth = monthlyPayment - interestPerMonth;

  const rows: AmortizationRow[] = [];
  let principalPaid = 0n;
  let cumulativeInterest = 0n;
  let paidSoFar = 0n;

  for (let month = 1; month <= months; month += 1) {
    const isFinal = month === months;

    // The last installment absorbs every rounding remainder so the schedule
    // closes out at exactly `totalRepayment`. Its principal slice is derived
    // from the payment for the same reason as above, which also makes it
    // exactly `principal - principalPaid`.
    const payment = isFinal ? totalRepayment - paidSoFar : monthlyPayment;
    const interestPortion = isFinal
      ? totalInterest - cumulativeInterest
      : interestPerMonth;
    const principalPortion = isFinal ? payment - interestPortion : principalPerMonth;

    principalPaid += principalPortion;
    cumulativeInterest += interestPortion;
    paidSoFar += payment;

    const status: PaymentStatus =
      month <= paymentsMade ? "paid" : month === paymentsMade + 1 ? "due" : "upcoming";

    rows.push({
      month,
      payment,
      principal: principalPortion,
      interest: interestPortion,
      remainingPrincipal: principal - principalPaid,
      remainingBalance: totalRepayment - paidSoFar,
      cumulativeInterest,
      status,
    });
  }

  const amountPaid = rows
    .filter((row) => row.status === "paid")
    .reduce((sum, row) => sum + row.payment, 0n);

  return {
    rows,
    summary: {
      monthlyPayment,
      totalInterest,
      totalRepayment,
      amountPaid,
      amountRemaining: totalRepayment - amountPaid,
    },
  };
}

/**
 * Renders a stroop amount as a human-readable token figure.
 *
 * Formatting goes through the integer part and the fractional part separately
 * so large balances never lose precision to a float conversion.
 */
export function formatStroops(stroops: bigint, decimals = 2): string {
  const negative = stroops < 0n;
  const absolute = negative ? -stroops : stroops;

  const whole = absolute / STROOPS_PER_UNIT;
  const remainder = absolute % STROOPS_PER_UNIT;

  const scale = 10n ** BigInt(decimals);
  const fraction = decimals > 0 ? (remainder * scale) / STROOPS_PER_UNIT : 0n;

  const wholeText = whole.toLocaleString("en-US");
  const fractionText =
    decimals > 0 ? `.${fraction.toString().padStart(decimals, "0")}` : "";

  return `${negative ? "-" : ""}${wholeText}${fractionText}`;
}

/** Converts a whole-token figure (e.g. from a form input) into stroops. */
export function toStroops(amount: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  return BigInt(Math.round(amount * Number(STROOPS_PER_UNIT)));
}

/** Renders a basis point rate as a percentage string (800 → "8.00%"). */
export function formatRateBps(interestRateBps: number): string {
  return `${(interestRateBps / 100).toFixed(2)}%`;
}
