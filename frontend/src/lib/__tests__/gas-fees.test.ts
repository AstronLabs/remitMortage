// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  baselineFeeStroops,
  buildFeeOptions,
  feeSliderRange,
  feeToUsd,
  formatFee,
  INCLUSION_FEE_STROOPS,
  isFeeBelowMinimum,
  matchFeeTier,
} from "../gas-fees";
import type { SimulationEstimate } from "../soroban-client";

const ESTIMATE: SimulationEstimate = {
  minResourceFeeStroops: "50000",
  instructions: "1200000",
  readBytes: "3200",
  writeBytes: "512",
  readEntries: "4",
  writeEntries: "2",
};

const BASELINE = 50_000 + INCLUSION_FEE_STROOPS;

describe("baselineFeeStroops", () => {
  it("adds the inclusion fee to the simulated resource fee", () => {
    expect(baselineFeeStroops(ESTIMATE)).toBe(BASELINE);
  });

  it("falls back to the inclusion fee without a simulation", () => {
    expect(baselineFeeStroops(null)).toBe(INCLUSION_FEE_STROOPS);
    expect(baselineFeeStroops({ ...ESTIMATE, minResourceFeeStroops: "0" })).toBe(
      INCLUSION_FEE_STROOPS
    );
  });
});

describe("buildFeeOptions", () => {
  it("returns standard, fast and instant tiers in ascending order", () => {
    const options = buildFeeOptions(ESTIMATE);
    expect(options.map((option) => option.tier)).toEqual([
      "standard",
      "fast",
      "instant",
    ]);
    expect(options.map((option) => option.stroops)).toEqual([
      BASELINE,
      BASELINE * 2,
      BASELINE * 5,
    ]);
  });
});

describe("feeSliderRange", () => {
  it("starts at the baseline and tops out above the instant tier", () => {
    const { min, max, step } = feeSliderRange(ESTIMATE);
    expect(min).toBe(BASELINE);
    expect(max).toBe(BASELINE * 10);
    expect(step).toBeGreaterThan(0);
    expect(max).toBeGreaterThan(min);
  });
});

describe("matchFeeTier", () => {
  it("identifies preset values and returns null for custom ones", () => {
    expect(matchFeeTier(BASELINE, ESTIMATE)).toBe("standard");
    expect(matchFeeTier(BASELINE * 2, ESTIMATE)).toBe("fast");
    expect(matchFeeTier(BASELINE * 5, ESTIMATE)).toBe("instant");
    expect(matchFeeTier(BASELINE + 7, ESTIMATE)).toBeNull();
  });
});

describe("isFeeBelowMinimum", () => {
  it("flags fees under the simulated resource fee", () => {
    expect(isFeeBelowMinimum(49_999, ESTIMATE)).toBe(true);
    expect(isFeeBelowMinimum(50_000, ESTIMATE)).toBe(false);
    expect(isFeeBelowMinimum(10, null)).toBe(false);
  });
});

describe("formatting", () => {
  it("shows stroops and XLM", () => {
    expect(formatFee(10_000_000)).toBe("10,000,000 stroops (1.0000000 XLM)");
    expect(formatFee(0)).toBe("—");
  });

  it("converts to USD only when a price is known", () => {
    expect(feeToUsd(10_000_000, 0.5)).toBe("0.5000");
    expect(feeToUsd(10_000_000, null)).toBeNull();
  });
});
