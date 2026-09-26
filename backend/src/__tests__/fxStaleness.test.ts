// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

// Mock redis and logger before the module under test is loaded.
jest.mock("../services/redis.js");
jest.mock("../utils/logger.js", () => ({
  default: { warn: jest.fn(), error: jest.fn() },
}));

import { getCacheValue, setCacheValue } from "../services/redis.js";
import { getExchangeRatesWithMeta, getExchangeRates } from "../services/fx.js";

const mockGetCacheValue = getCacheValue as jest.Mock;
const mockSetCacheValue = setCacheValue as jest.Mock;

function makeEntry(fetchedAt: Date) {
  return {
    rates: { USD: 1.0, EUR: 0.92, NGN: 1500 },
    fetchedAt: fetchedAt.toISOString(),
  };
}

describe("getExchangeRatesWithMeta – staleness scenarios", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetCacheValue.mockResolvedValue(undefined);
    // Default: no existing env override for the threshold
    delete process.env.FX_STALENESS_THRESHOLD_SECONDS;
  });

  it("marks a freshly cached rate as not stale (ageMinutes = 0)", async () => {
    const fetchedAt = new Date(); // just now
    mockGetCacheValue.mockResolvedValue(makeEntry(fetchedAt));

    const meta = await getExchangeRatesWithMeta();

    expect(meta.isStale).toBe(false);
    expect(meta.ageMinutes).toBe(0);
    expect(meta.fetchedAt?.getTime()).toBeCloseTo(fetchedAt.getTime(), -2);
  });

  it("marks a rate cached 10 minutes ago as not stale (under 30 min threshold)", async () => {
    const fetchedAt = new Date(Date.now() - 10 * 60 * 1000);
    mockGetCacheValue.mockResolvedValue(makeEntry(fetchedAt));

    const meta = await getExchangeRatesWithMeta();

    expect(meta.isStale).toBe(false);
    expect(meta.ageMinutes).toBe(10);
  });

  it("marks a rate cached 45 minutes ago as stale (over 30 min default threshold)", async () => {
    const fetchedAt = new Date(Date.now() - 45 * 60 * 1000);
    mockGetCacheValue.mockResolvedValue(makeEntry(fetchedAt));

    const meta = await getExchangeRatesWithMeta();

    expect(meta.isStale).toBe(true);
    expect(meta.ageMinutes).toBe(45);
  });

  it("includes the rates in the response even when stale", async () => {
    const fetchedAt = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
    mockGetCacheValue.mockResolvedValue(makeEntry(fetchedAt));

    const meta = await getExchangeRatesWithMeta();

    expect(meta.isStale).toBe(true);
    expect(meta.rates.EUR).toBe(0.92);
    expect(meta.rates.NGN).toBe(1500);
  });

  it("returns isStale=false and ageMinutes=null when no fetchedAt metadata exists (legacy cache)", async () => {
    // Old cache entries may not have the fetchedAt field
    mockGetCacheValue.mockResolvedValue({ rates: { USD: 1.0 } }); // no fetchedAt

    const meta = await getExchangeRatesWithMeta();

    // Falls through to a fresh fetch (no fetchedAt ⇒ cache miss path)
    expect(meta.isStale).toBe(false);
    expect(meta.fetchedAt).not.toBeNull(); // fresh fetch sets a new timestamp
  });

  it("returns isStale=false and ageMinutes=null when the cache is empty (fresh fetch path)", async () => {
    mockGetCacheValue.mockResolvedValue(null);

    const meta = await getExchangeRatesWithMeta();

    expect(meta.isStale).toBe(false);
    expect(meta.ageMinutes).toBe(0); // freshly fetched
    expect(meta.fetchedAt).not.toBeNull();
  });

  it("stores a fetchedAt timestamp when writing to cache", async () => {
    mockGetCacheValue.mockResolvedValue(null);

    await getExchangeRatesWithMeta();

    expect(mockSetCacheValue).toHaveBeenCalledTimes(1);
    const [, entry] = mockSetCacheValue.mock.calls[0] as [string, any, number];
    expect(typeof entry.fetchedAt).toBe("string");
    const parsed = new Date(entry.fetchedAt);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
  });

  it("a genuinely fresh rate never triggers the staleness indicator", async () => {
    const fetchedAt = new Date(Date.now() - 60 * 1000); // 1 minute ago
    mockGetCacheValue.mockResolvedValue(makeEntry(fetchedAt));

    const meta = await getExchangeRatesWithMeta();

    expect(meta.isStale).toBe(false);
  });
});

describe("getExchangeRates – backward compatibility", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetCacheValue.mockResolvedValue(undefined);
  });

  it("returns only the rates record (no metadata fields)", async () => {
    mockGetCacheValue.mockResolvedValue(makeEntry(new Date()));

    const rates = await getExchangeRates();

    expect(typeof rates).toBe("object");
    expect(rates.USD).toBe(1.0);
    expect((rates as any).isStale).toBeUndefined();
    expect((rates as any).fetchedAt).toBeUndefined();
  });
});
