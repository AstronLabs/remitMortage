// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

export interface PayoffCountdown {
  paymentsRemaining: number;
  estimatedPayoffDate: Date | null;
}

/**
 * Computes how many payments are left and the estimated payoff date.
 * Uses a 30-day-per-payment approximation; replace with an actual
 * amortization schedule when the Soroban contract exposes one.
 */
export function computePayoffCountdown(
  paymentsMade: number,
  durationMonths: number,
  referenceDate?: Date
): PayoffCountdown {
  const paymentsRemaining = Math.max(0, durationMonths - paymentsMade);
  const ref = referenceDate ?? new Date();
  const estimatedPayoffDate =
    paymentsRemaining > 0
      ? new Date(ref.getTime() + paymentsRemaining * 30 * 24 * 60 * 60 * 1000)
      : null;
  return { paymentsRemaining, estimatedPayoffDate };
}

/**
 * Returns true when a payment of `paymentAmount` will bring the remaining
 * balance to zero — i.e. this is the final payment.
 */
export function isFinalPayment(paymentAmount: number, remainingBalance: number): boolean {
  return remainingBalance > 0 && paymentAmount >= remainingBalance;
}
