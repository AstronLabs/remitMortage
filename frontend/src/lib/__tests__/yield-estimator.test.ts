// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  BPS_SCALE,
  ESTIMATOR_MONTHS,
  bpsToPercent,
  buildYieldTimeline,
  effectiveApyBps,
  estimateYield,
} from "../yield-estimator";

describe("bpsToPercent", () => {
  it("converts basis points to a percentage string", () => {
    expect(bpsToPercent(450, 1)).toBe("4.5");
    expect(bpsToPercent(620, 2)).toBe("6.20");
    expect(bpsToPercent(0)).toBe("0.00");
  });
});

describe("buildYieldTimeline", () => {
  it("emits month 0 plus one point per projected month", () => {
    const timeline = buildYieldTimeline(1000, 450, 24);
    expect(timeline).toHaveLength(25);
    expect(timeline[0]).toEqual({ month: 0, balance: 1000, earned: 0 });
    expect(timeline[timeline.length - 1].month).toBe(24);
  });

  it("compounds monthly at apy/12, matching P(1 + r/12)^n", () => {
    const principal = 10_000;
    const apyBps = 1200; // 12% nominal
    const timeline = buildYieldTimeline(principal, apyBps, 12);

    const monthlyRate = apyBps / BPS_SCALE / 12; // 0.01
    const expected = principal * Math.pow(1 + monthlyRate, 12);

    // Compare within a cent — the implementation rounds to whole cents.
    expect(timeline[12].balance).toBeCloseTo(Math.round(expected * 100) / 100, 2);
    expect(timeline[12].earned).toBeCloseTo(timeline[12].balance - principal, 2);
  });

  it("earns nothing when the APY is zero", () => {
    const timeline = buildYieldTimeline(5000, 0, 24);
    expect(timeline.every((p) => p.balance === 5000)).toBe(true);
    expect(timeline[timeline.length - 1].earned).toBe(0);
  });

  it("clamps negative or non-finite inputs instead of producing NaN", () => {
    const timeline = buildYieldTimeline(-100, Number.NaN, 24);
    expect(timeline[0].balance).toBe(0);
    expect(timeline.every((p) => Number.isFinite(p.balance))).toBe(true);
    // A non-finite month count falls back to a single projected month.
    const shortTimeline = buildYieldTimeline(1000, 450, Number.NaN);
    expect(shortTimeline).toHaveLength(2);
  });
});

describe("effectiveApyBps", () => {
  it("is greater than nominal because of monthly compounding", () => {
    const nominal = 1200;
    const effective = effectiveApyBps(nominal);
    // (1.01)^12 - 1 ≈ 12.6825%
    expect(effective).toBeGreaterThan(nominal);
    expect(effective).toBe(Math.round((Math.pow(1.01, 12) - 1) * BPS_SCALE));
  });

  it("returns zero for a zero rate", () => {
    expect(effectiveApyBps(0)).toBe(0);
  });
});

describe("estimateYield", () => {
  it("summarises the final balance and earnings over the duration", () => {
    const estimate = estimateYield(10_000, 450, 24);
    expect(estimate.principal).toBe(10_000);
    expect(estimate.apyBps).toBe(450);
    expect(estimate.months).toBe(24);
    expect(estimate.timeline).toHaveLength(25);
    expect(estimate.finalBalance).toBeGreaterThan(10_000);
    expect(estimate.totalEarned).toBeCloseTo(
      estimate.finalBalance - 10_000,
      2
    );
    expect(estimate.effectiveApyBps).toBeGreaterThan(450);
  });

  it("defaults to the 24-month estimator horizon", () => {
    const estimate = estimateYield(1000, 450);
    expect(estimate.months).toBe(ESTIMATOR_MONTHS);
  });
});
