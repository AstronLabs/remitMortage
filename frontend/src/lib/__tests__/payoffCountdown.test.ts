// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { computePayoffCountdown, isFinalPayment } from "../payoffCountdown";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MONTH = 30 * MS_PER_DAY;

describe("computePayoffCountdown", () => {
  it("returns zero remaining and null date when all payments are made", () => {
    const result = computePayoffCountdown(12, 12);
    expect(result.paymentsRemaining).toBe(0);
    expect(result.estimatedPayoffDate).toBeNull();
  });

  it("calculates remaining payments correctly", () => {
    const result = computePayoffCountdown(4, 12);
    expect(result.paymentsRemaining).toBe(8);
  });

  it("floors remaining at 0 when payments-made exceeds duration", () => {
    const result = computePayoffCountdown(15, 12);
    expect(result.paymentsRemaining).toBe(0);
    expect(result.estimatedPayoffDate).toBeNull();
  });

  it("estimates the payoff date as reference + (remaining × 30 days)", () => {
    const ref = new Date("2026-01-01T00:00:00.000Z");
    const { estimatedPayoffDate } = computePayoffCountdown(9, 12, ref);
    // 3 payments × 30 days = 90 days
    const expected = new Date(ref.getTime() + 3 * MS_PER_MONTH);
    expect(estimatedPayoffDate?.getTime()).toBe(expected.getTime());
  });

  it("uses today as the reference date when none is provided", () => {
    const before = Date.now();
    const { estimatedPayoffDate } = computePayoffCountdown(0, 12);
    const after = Date.now();

    // Should be approximately 12 months from now
    const expectedMin = before + 12 * MS_PER_MONTH;
    const expectedMax = after + 12 * MS_PER_MONTH;
    expect(estimatedPayoffDate!.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(estimatedPayoffDate!.getTime()).toBeLessThanOrEqual(expectedMax);
  });

  it("returns null payoff date for a fully paid schedule", () => {
    const { estimatedPayoffDate } = computePayoffCountdown(12, 12);
    expect(estimatedPayoffDate).toBeNull();
  });
});

describe("isFinalPayment", () => {
  it("returns true when payment covers the exact remaining balance", () => {
    expect(isFinalPayment(500, 500)).toBe(true);
  });

  it("returns true when payment exceeds the remaining balance", () => {
    expect(isFinalPayment(600, 500)).toBe(true);
  });

  it("returns false when payment is less than remaining balance", () => {
    expect(isFinalPayment(499, 500)).toBe(false);
  });

  it("returns false when remaining balance is zero (already paid)", () => {
    expect(isFinalPayment(500, 0)).toBe(false);
  });

  it("celebration screen is gated on the final payment — not triggered for partial payments", () => {
    // Simulates the guard used in RepayInner before setting showCelebration
    const monthlyPayment = 500;
    const totalBalance = 6000;

    for (let paid = 0; paid < totalBalance; paid += monthlyPayment) {
      const remaining = totalBalance - paid;
      if (remaining > monthlyPayment) {
        expect(isFinalPayment(monthlyPayment, remaining)).toBe(false);
      }
    }
    // Only the last payment triggers it
    expect(isFinalPayment(monthlyPayment, monthlyPayment)).toBe(true);
  });
});
