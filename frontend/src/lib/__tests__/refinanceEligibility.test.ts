// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { checkRefinanceEligibility } from "../refinanceEligibility";

const GOOD = {
  monthsSinceOrigination: 12,
  currentRateBps: 650,
  offeredRateBps: 550,
  onTimePaymentRatio: 0.98,
  isDelinquent: false,
};

describe("checkRefinanceEligibility", () => {
  it("marks an eligible loan eligible with no blocking reasons", () => {
    const r = checkRefinanceEligibility(GOOD);
    expect(r.eligible).toBe(true);
    expect(r.blockingReasons).toEqual([]);
  });

  it("blocks loans younger than the minimum seasoning", () => {
    const r = checkRefinanceEligibility({ ...GOOD, monthsSinceOrigination: 2 });
    expect(r.eligible).toBe(false);
    expect(r.blockingReasons.some((m) => /since origination/i.test(m))).toBe(true);
  });

  it("blocks insufficient rate improvement", () => {
    const r = checkRefinanceEligibility({ ...GOOD, offeredRateBps: 630 });
    expect(r.eligible).toBe(false);
    expect(r.blockingReasons.some((m) => /bps/i.test(m))).toBe(true);
  });

  it("blocks when the offered rate is not lower", () => {
    const r = checkRefinanceEligibility({ ...GOOD, offeredRateBps: 700 });
    expect(r.eligible).toBe(false);
    expect(r.blockingReasons.some((m) => /not lower|not reduce/i.test(m))).toBe(true);
  });

  it("blocks poor payment history", () => {
    const r = checkRefinanceEligibility({ ...GOOD, onTimePaymentRatio: 0.5 });
    expect(r.eligible).toBe(false);
    expect(r.blockingReasons.some((m) => /on-time/i.test(m))).toBe(true);
  });

  it("blocks delinquent loans", () => {
    const r = checkRefinanceEligibility({ ...GOOD, isDelinquent: true });
    expect(r.eligible).toBe(false);
    expect(r.blockingReasons.some((m) => /delinquent/i.test(m))).toBe(true);
  });

  it("blocks duplicate in-flight requests", () => {
    const r = checkRefinanceEligibility({ ...GOOD, hasPendingRefinanceRequest: true });
    expect(r.eligible).toBe(false);
    expect(r.blockingReasons.some((m) => /already in progress/i.test(m))).toBe(true);
  });

  it("reports all blocking reasons in combination", () => {
    const r = checkRefinanceEligibility({
      monthsSinceOrigination: 1,
      currentRateBps: 600,
      offeredRateBps: 600,
      onTimePaymentRatio: 0.2,
      isDelinquent: true,
    });
    expect(r.eligible).toBe(false);
    expect(r.blockingReasons.length).toBeGreaterThanOrEqual(4);
  });
});
