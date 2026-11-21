import { formatUpdatedAt, isStale } from "../dataFreshness";

describe("data freshness", () => {
  const now = Date.parse("2026-11-21T12:00:00.000Z");

  it("marks data fresh inside its card threshold", () => {
    expect(isStale("2026-11-21T11:58:00.000Z", 5 * 60 * 1000, now)).toBe(false);
  });

  it("marks data stale after its card threshold", () => {
    expect(isStale("2026-11-21T11:54:59.000Z", 5 * 60 * 1000, now)).toBe(true);
  });

  it("handles invalid timestamps visibly", () => {
    expect(isStale("not-a-date", 5 * 60 * 1000, now)).toBe(true);
    expect(formatUpdatedAt("not-a-date")).toBe("Last updated: unavailable");
  });
});
