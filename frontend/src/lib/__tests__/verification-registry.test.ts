// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  VERIFICATION_DATA_KEY,
  VERIFICATION_CACHE_TTL_MS,
  clearVerificationCache,
  getVerificationStatus,
} from "../verification-registry";

const ADDR = "GABC000000000000000000000000000000000000000000000000000";

/** Base64-encode a value the way Horizon encodes account data entries. */
const b64 = (value: string) => Buffer.from(value, "utf-8").toString("base64");

/** Build a data_attr map carrying a verification expiry (Unix seconds). */
const withExpiry = (seconds: number) => ({
  [VERIFICATION_DATA_KEY]: b64(String(seconds)),
});

describe("getVerificationStatus", () => {
  beforeEach(() => {
    clearVerificationCache();
  });

  it("returns verified for an unexpired verification record", async () => {
    const nowMs = 1_000_000_000_000;
    const fetcher = jest.fn().mockResolvedValue(
      withExpiry(nowMs / 1000 + 3600) // expires in 1 hour
    );

    const record = await getVerificationStatus(ADDR, {
      fetcher,
      now: () => nowMs,
    });

    expect(record.state).toBe("verified");
    expect(record.verifiedUntil).toBe(nowMs / 1000 + 3600);
  });

  it("returns unverified when the account holds no verification record", async () => {
    const fetcher = jest.fn().mockResolvedValue({});
    const record = await getVerificationStatus(ADDR, { fetcher });

    expect(record.state).toBe("unverified");
    expect(record.verifiedUntil).toBeNull();
  });

  it("treats an expired verification record as unverified", async () => {
    const nowMs = 1_000_000_000_000;
    const fetcher = jest.fn().mockResolvedValue(
      withExpiry(nowMs / 1000 - 60) // expired a minute ago
    );

    const record = await getVerificationStatus(ADDR, {
      fetcher,
      now: () => nowMs,
    });

    expect(record.state).toBe("unverified");
  });

  it("serves cached results without re-hitting Horizon within the TTL", async () => {
    const nowMs = 1_000_000_000_000;
    const fetcher = jest.fn().mockResolvedValue(withExpiry(nowMs / 1000 + 3600));

    await getVerificationStatus(ADDR, { fetcher, now: () => nowMs });
    await getVerificationStatus(ADDR, { fetcher, now: () => nowMs + 1000 });

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent lookups into a single Horizon request", async () => {
    const nowMs = 1_000_000_000_000;
    const fetcher = jest.fn().mockResolvedValue(withExpiry(nowMs / 1000 + 3600));

    const [a, b] = await Promise.all([
      getVerificationStatus(ADDR, { fetcher, now: () => nowMs }),
      getVerificationStatus(ADDR, { fetcher, now: () => nowMs }),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(a.state).toBe("verified");
    expect(b.state).toBe("verified");
  });

  it("flips a cached record to unverified once it expires within the TTL", async () => {
    const nowMs = 1_000_000_000_000;
    const expiresAtSeconds = nowMs / 1000 + 30; // expires in 30s
    const fetcher = jest.fn().mockResolvedValue(withExpiry(expiresAtSeconds));

    const first = await getVerificationStatus(ADDR, {
      fetcher,
      now: () => nowMs,
    });
    expect(first.state).toBe("verified");

    // 40s later: still inside the 60s cache window, but the record has lapsed.
    const later = nowMs + 40_000;
    expect(later).toBeLessThan(nowMs + VERIFICATION_CACHE_TTL_MS);

    const second = await getVerificationStatus(ADDR, {
      fetcher,
      now: () => later,
    });

    expect(second.state).toBe("unverified");
    // Still no second Horizon call — the flip came from re-deriving expiry.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bypasses the cache when force is set", async () => {
    const nowMs = 1_000_000_000_000;
    const fetcher = jest.fn().mockResolvedValue(withExpiry(nowMs / 1000 + 3600));

    await getVerificationStatus(ADDR, { fetcher, now: () => nowMs });
    await getVerificationStatus(ADDR, { fetcher, now: () => nowMs, force: true });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
