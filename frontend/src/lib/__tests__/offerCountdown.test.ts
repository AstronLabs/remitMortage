// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  DEFAULT_URGENT_THRESHOLD_MS,
  formatRemaining,
  getOfferCountdown,
  isOfferExpired,
} from "../offerCountdown";

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

describe("getOfferCountdown", () => {
  it("measures the exact time left until the deadline", () => {
    const state = getOfferCountdown(NOW + 2 * 3_600_000 + 3 * 60_000 + 4_000, NOW);
    expect(state.remainingMs).toBe(7_384_000);
    expect(state.label).toBe("02:03:04");
    expect(state.expired).toBe(false);
    expect(state.urgent).toBe(false);
  });

  it("accepts ISO strings and Dates", () => {
    const iso = new Date(NOW + 90_000).toISOString();
    expect(getOfferCountdown(iso, NOW).label).toBe("01:30");
    expect(getOfferCountdown(new Date(NOW + 90_000), NOW).label).toBe("01:30");
  });

  it("turns urgent at the threshold, not before", () => {
    expect(getOfferCountdown(NOW + DEFAULT_URGENT_THRESHOLD_MS + 1000, NOW).urgent).toBe(false);
    expect(getOfferCountdown(NOW + DEFAULT_URGENT_THRESHOLD_MS, NOW).urgent).toBe(true);
    expect(getOfferCountdown(NOW + 30_000, NOW, 60_000).urgent).toBe(true);
  });

  it("is expired, not urgent, at and after the deadline", () => {
    for (const expiresAt of [NOW, NOW - 1]) {
      const state = getOfferCountdown(expiresAt, NOW);
      expect(state).toMatchObject({ remainingMs: 0, expired: true, urgent: false, label: "00:00" });
    }
    expect(isOfferExpired(NOW + 1, NOW)).toBe(false);
  });

  it("treats an unparseable deadline as expired", () => {
    expect(getOfferCountdown("not a date", NOW).expired).toBe(true);
  });
});

describe("formatRemaining", () => {
  it("shows days when more than a day remains", () => {
    expect(formatRemaining(2 * 86_400_000 + 3_600_000 + 61_000)).toBe("2d 01:01:01");
  });

  it("rounds partial seconds up so it never shows 00:00 early", () => {
    expect(formatRemaining(400)).toBe("00:01");
  });
});
