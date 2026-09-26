// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

// Pure yield / APY estimator math for the dashboard calculator.
//
// The estimator models the escrow yield the same way the rest of the app does
// (see ROIProjectionWidget) — monthly compounding of a nominal annual rate:
//
//     balance_after_month = balance * (1 + apy / 12)
//
// Rates are expressed in basis points (bps) to stay aligned with the on-chain
// convention used across the contracts and lib/amortization.ts (10,000 bps =
// 100%). Keeping the math here as pure functions lets the UI recompute on every
// keystroke and lets the numbers be unit-tested without rendering a chart.

/** Basis-point scale: 10,000 bps = 100%. Matches BPS_SCALE on-chain. */
export const BPS_SCALE = 10_000;

/** Timeline length the estimator projects, in months. */
export const ESTIMATOR_MONTHS = 24;

/** One point on the projected growth timeline. */
export interface YieldPoint {
  /** 0-based month offset (0 = today / initial deposit). */
  month: number;
  /** Projected total balance (principal + accrued yield) at this month. */
  balance: number;
  /** Cumulative yield earned since month 0 at this point. */
  earned: number;
}

/** Summary figures derived from a full projection. */
export interface YieldEstimate {
  /** The initial deposit amount. */
  principal: number;
  /** Active APY in basis points used for the projection. */
  apyBps: number;
  /** Number of months projected. */
  months: number;
  /** Per-month timeline including month 0. */
  timeline: YieldPoint[];
  /** Balance at the end of the selected duration. */
  finalBalance: number;
  /** Total yield earned over the selected duration. */
  totalEarned: number;
  /**
   * Effective annual yield actually realised over 12 months of monthly
   * compounding, in basis points — i.e. (1 + apy/12)^12 − 1. Always ≥ the
   * nominal APY because of compounding.
   */
  effectiveApyBps: number;
}

/** Convert a basis-point rate to a percentage string, e.g. 450 → "4.5". */
export function bpsToPercent(bps: number, fractionDigits = 2): string {
  return (bps / 100).toFixed(fractionDigits);
}

/** Round to whole cents to avoid floating-point noise in displayed figures. */
function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Build the monthly-compounding growth timeline for a deposit.
 *
 * Negative or non-finite inputs are clamped so the UI never renders NaN while a
 * user is mid-typing. `months` is clamped to at least 1 so a single point is
 * always produced beyond month 0.
 */
export function buildYieldTimeline(
  principal: number,
  apyBps: number,
  months: number = ESTIMATOR_MONTHS
): YieldPoint[] {
  const safePrincipal = Number.isFinite(principal) && principal > 0 ? principal : 0;
  const safeApyBps = Number.isFinite(apyBps) && apyBps > 0 ? apyBps : 0;
  const safeMonths = Number.isFinite(months) ? Math.max(1, Math.floor(months)) : 1;

  const monthlyRate = safeApyBps / BPS_SCALE / 12;

  const timeline: YieldPoint[] = [
    { month: 0, balance: roundMoney(safePrincipal), earned: 0 },
  ];

  let balance = safePrincipal;
  for (let month = 1; month <= safeMonths; month++) {
    balance = balance * (1 + monthlyRate);
    timeline.push({
      month,
      balance: roundMoney(balance),
      earned: roundMoney(balance - safePrincipal),
    });
  }

  return timeline;
}

/**
 * Effective annual yield from monthly compounding, in basis points:
 * (1 + apy/12)^12 − 1.
 */
export function effectiveApyBps(apyBps: number): number {
  const safeApyBps = Number.isFinite(apyBps) && apyBps > 0 ? apyBps : 0;
  const monthlyRate = safeApyBps / BPS_SCALE / 12;
  const effective = Math.pow(1 + monthlyRate, 12) - 1;
  return Math.round(effective * BPS_SCALE);
}

/**
 * Full estimate: the timeline plus summary figures for a deposit held for the
 * given duration at the given APY. This is the single entry point the UI calls
 * on every input change.
 */
export function estimateYield(
  principal: number,
  apyBps: number,
  months: number = ESTIMATOR_MONTHS
): YieldEstimate {
  const timeline = buildYieldTimeline(principal, apyBps, months);
  const last = timeline[timeline.length - 1];
  const safePrincipal = Number.isFinite(principal) && principal > 0 ? principal : 0;
  const safeApyBps = Number.isFinite(apyBps) && apyBps > 0 ? apyBps : 0;

  return {
    principal: roundMoney(safePrincipal),
    apyBps: safeApyBps,
    months: last.month,
    timeline,
    finalBalance: last.balance,
    totalEarned: last.earned,
    effectiveApyBps: effectiveApyBps(safeApyBps),
  };
}
