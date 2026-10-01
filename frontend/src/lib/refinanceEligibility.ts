// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Refinance eligibility rules (issue #753).
 *
 * Pure, testable core for the borrower refinance eligibility checker:
 * evaluates a borrower's existing loan (already on file) against the
 * current offered rate. Each failing rule yields a specific blocking
 * reason — never a generic "not eligible".
 */

export interface RefinanceLoanSnapshot {
  /** Months since origination. */
  monthsSinceOrigination: number;
  /** Current loan rate in basis points. */
  currentRateBps: number;
  /** Best currently offered refinance rate in basis points. */
  offeredRateBps: number;
  /** Share of scheduled payments made on time, 0..1. */
  onTimePaymentRatio: number;
  /** True while the loan is delinquent / in default. */
  isDelinquent: boolean;
  /** True when a refinance request is already in flight. */
  hasPendingRefinanceRequest?: boolean;
}

export interface RefinanceEligibilityResult {
  eligible: boolean;
  /** Specific blocking reason(s) when not eligible. Empty when eligible. */
  blockingReasons: string[];
  /** Rate improvement in bps (positive = cheaper). */
  rateDeltaBps: number;
}

export const MIN_MONTHS_SINCE_ORIGINATION = 6;
export const MIN_RATE_DELTA_BPS = 50;
export const MIN_ON_TIME_RATIO = 0.9;

export function checkRefinanceEligibility(
  loan: RefinanceLoanSnapshot
): RefinanceEligibilityResult {
  const blockingReasons: string[] = [];
  const rateDeltaBps = loan.currentRateBps - loan.offeredRateBps;

  if (loan.monthsSinceOrigination < MIN_MONTHS_SINCE_ORIGINATION) {
    blockingReasons.push(
      `Loan is only ${loan.monthsSinceOrigination} month(s) old — refinancing requires at least ${MIN_MONTHS_SINCE_ORIGINATION} months since origination.`
    );
  }
  if (rateDeltaBps < MIN_RATE_DELTA_BPS) {
    blockingReasons.push(
      rateDeltaBps <= 0
        ? `Current offered rate (${loan.offeredRateBps} bps) is not lower than your rate (${loan.currentRateBps} bps) — refinancing would not reduce your payments.`
        : `Rate improvement is only ${rateDeltaBps} bps — refinancing requires at least ${MIN_RATE_DELTA_BPS} bps to be worthwhile.`
    );
  }
  if (loan.onTimePaymentRatio < MIN_ON_TIME_RATIO) {
    blockingReasons.push(
      `On-time payment history is ${Math.round(loan.onTimePaymentRatio * 100)}% — refinancing requires at least ${Math.round(MIN_ON_TIME_RATIO * 100)}% on-time payments.`
    );
  }
  if (loan.isDelinquent) {
    blockingReasons.push(
      "Loan is currently delinquent — bring the loan back into good standing before refinancing."
    );
  }
  if (loan.hasPendingRefinanceRequest) {
    blockingReasons.push(
      "A refinance request is already in progress — wait for it to complete before starting a new one."
    );
  }

  return { eligible: blockingReasons.length === 0, blockingReasons, rateDeltaBps };
}
