// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

// Shared types and pure helpers for remittance eligibility verification.
// Used by both the /verify page and the POST /api/verification/check route.

/** Minimum number of payments to the recipient required for eligibility. */
export const MIN_PAYMENTS = 3;
/** Minimum payment history span (in months) required for eligibility. */
export const MIN_MONTHS = 3;

export interface VerificationStats {
  /** Number of payments found from the sender to the recipient. */
  totalPayments: number;
  /** Total remittance volume across those payments, in USDC. */
  totalVolume: number;
  /** Average payment amount, in USDC. */
  averagePayment: number;
  /** Span between the first and last payment, in whole months. */
  timespanMonths: number;
  /** ISO date of the first payment, or null when none were found. */
  firstPaymentDate: string | null;
  /** ISO date of the most recent payment, or null when none were found. */
  lastPaymentDate: string | null;
}

export interface VerificationResult {
  eligible: boolean;
  message: string;
  stats: VerificationStats;
}

/** A single payment matched between sender and recipient. */
export interface MatchedPayment {
  amount: number;
  createdAt: string;
}

const AVG_DAYS_PER_MONTH = 30.44;

/** Validate a Stellar public key (G... ed25519 address). */
export function isValidStellarAddress(address: unknown): address is string {
  return typeof address === "string" && /^G[A-Z2-7]{55}$/.test(address);
}

function roundUsdc(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Derive eligibility statistics from the matched payments. Pure function. */
export function computeStats(payments: MatchedPayment[]): VerificationStats {
  const totalPayments = payments.length;
  const totalVolume = roundUsdc(
    payments.reduce(
      (sum, payment) => sum + (Number.isFinite(payment.amount) ? payment.amount : 0),
      0
    )
  );
  const averagePayment = totalPayments > 0 ? roundUsdc(totalVolume / totalPayments) : 0;

  const times = payments
    .map((payment) => new Date(payment.createdAt).getTime())
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => a - b);

  const first = times.length > 0 ? times[0] : null;
  const last = times.length > 0 ? times[times.length - 1] : null;
  const timespanMonths =
    first !== null && last !== null
      ? Math.round((last - first) / (AVG_DAYS_PER_MONTH * 24 * 60 * 60 * 1000))
      : 0;

  return {
    totalPayments,
    totalVolume,
    averagePayment,
    timespanMonths,
    firstPaymentDate: first !== null ? new Date(first).toISOString() : null,
    lastPaymentDate: last !== null ? new Date(last).toISOString() : null,
  };
}

/** Apply the eligibility rule to a computed stats object. */
export function isEligible(stats: VerificationStats): boolean {
  return (
    stats.totalPayments >= MIN_PAYMENTS &&
    stats.timespanMonths >= MIN_MONTHS &&
    stats.totalVolume > 0
  );
}
