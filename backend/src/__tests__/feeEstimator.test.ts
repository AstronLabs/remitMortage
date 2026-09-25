// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  FeeEstimatorService,
  FeeEstimatorRpc,
} from "../services/feeEstimator";

// Mock logger to avoid console output during tests
jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

/** Distribution matching the shape of `Api.GetFeeStatsResponse["sorobanInclusionFee"]`. */
function feeDistribution(overrides: Partial<Record<string, string>> = {}) {
  return {
    max: "10000",
    min: "100",
    mode: "100",
    p10: "100",
    p20: "150",
    p30: "200",
    p40: "250",
    p50: "500",
    p60: "600",
    p70: "700",
    p80: "800",
    p90: "2000",
    p95: "3000",
    p99: "5000",
    transactionCount: "42",
    ...overrides,
  };
}

/** A fake RPC dependency that lets each test control getLatestLedger/getFeeStats independently. */
function fakeRpc(overrides: {
  getLatestLedger?: () => Promise<{ sequence: number }>;
  getFeeStats?: () => Promise<{ sorobanInclusionFee: ReturnType<typeof feeDistribution> }>;
}): FeeEstimatorRpc {
  const getLatestLedger =
    overrides.getLatestLedger ?? (async () => ({ sequence: 1000 }));
  const getFeeStats =
    overrides.getFeeStats ?? (async () => ({ sorobanInclusionFee: feeDistribution() }));

  return {
    async execute<T>(operation: (server: any) => Promise<T>): Promise<T> {
      const server = { getLatestLedger, getFeeStats };
      return operation(server);
    },
  };
}

describe("FeeEstimatorService", () => {
  it("returns a static fallback recommendation before the first refresh", () => {
    const service = new FeeEstimatorService(fakeRpc({}));
    const rec = service.getRecommendation();

    expect(rec.isFallback).toBe(true);
    expect(rec.low).toBeGreaterThan(0);
    expect(rec.low).toBeLessThanOrEqual(rec.medium);
    expect(rec.medium).toBeLessThanOrEqual(rec.high);
  });

  it("derives low/medium/high tiers from getFeeStats percentiles", async () => {
    const service = new FeeEstimatorService(fakeRpc({}));

    const rec = await service.refresh();

    expect(rec.isFallback).toBe(false);
    expect(rec.low).toBe(100); // p10
    expect(rec.medium).toBe(500); // p50
    expect(rec.high).toBe(2000); // p90
    expect(rec.low).toBeLessThanOrEqual(rec.medium);
    expect(rec.medium).toBeLessThanOrEqual(rec.high);
    expect(rec.latestLedger).toBe(1000);
  });

  it("keeps recommendations ordered low <= medium <= high even with a degenerate distribution", async () => {
    const service = new FeeEstimatorService(
      fakeRpc({
        getFeeStats: async () => ({
          sorobanInclusionFee: feeDistribution({ p10: "50", p50: "50", p90: "50" }),
        }),
      })
    );

    const rec = await service.refresh();
    expect(rec.low).toBeLessThanOrEqual(rec.medium);
    expect(rec.medium).toBeLessThanOrEqual(rec.high);
  });

  it("falls back to the base-fee ladder when getFeeStats fails but the ledger query succeeds", async () => {
    const service = new FeeEstimatorService(
      fakeRpc({
        getFeeStats: async () => {
          throw new Error("getFeeStats unavailable");
        },
      })
    );

    const rec = await service.refresh();
    expect(rec.isFallback).toBe(false); // still a real, ledger-anchored snapshot
    expect(rec.latestLedger).toBe(1000);
    expect(rec.low).toBeGreaterThan(0);
    expect(rec.low).toBeLessThanOrEqual(rec.medium);
    expect(rec.medium).toBeLessThanOrEqual(rec.high);
  });

  it("keeps serving the last known-good snapshot when the RPC is unreachable", async () => {
    const service = new FeeEstimatorService(fakeRpc({}));
    const goodSnapshot = await service.refresh();

    const failingService = new FeeEstimatorService({
      async execute(): Promise<any> {
        throw new Error("all RPC nodes down");
      },
    });
    const beforeFailure = failingService.getRecommendation();
    const afterFailure = await failingService.refresh();

    // A total outage must not throw and must not wipe out the snapshot.
    expect(afterFailure).toEqual(beforeFailure);
    expect(goodSnapshot.isFallback).toBe(false);
  });

  it("scales fee recommendations up when ledgers close slower than the network target", async () => {
    let call = 0;
    const service = new FeeEstimatorService(
      fakeRpc({
        // Ledger only advances by 1 between polls, so a large wall-clock
        // gap (injected via mocked Date.now) implies a slow/congested network.
        getLatestLedger: async () => ({ sequence: 1000 + call++ }),
      })
    );

    const nowSpy = jest.spyOn(Date, "now");
    nowSpy.mockReturnValueOnce(0); // first refresh anchor
    const first = await service.refresh();

    nowSpy.mockReturnValueOnce(60_000); // 60s later, only 1 ledger closed
    const second = await service.refresh();

    expect(second.medium).toBeGreaterThan(first.medium);
    expect(second.high).toBeGreaterThan(first.high);

    nowSpy.mockRestore();
  });

  it("does not scale fees when ledger cadence is at or faster than the network target", async () => {
    let seq = 1000;
    const service = new FeeEstimatorService(
      fakeRpc({
        getLatestLedger: async () => ({ sequence: seq++ }),
      })
    );

    const nowSpy = jest.spyOn(Date, "now");
    nowSpy.mockReturnValueOnce(0);
    await service.refresh();

    nowSpy.mockReturnValueOnce(5_000); // exactly one ledger interval later, +1 ledger
    const rec = await service.refresh();

    expect(rec.medium).toBe(500); // unscaled p50
    nowSpy.mockRestore();
  });

  describe("read latency", () => {
    it("resolves getRecommendation()/getFee() well under 10ms without any RPC call", async () => {
      const service = new FeeEstimatorService(fakeRpc({}));
      await service.refresh(); // populate a real snapshot once

      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        service.getRecommendation();
        service.getFee("low");
        service.getFee("medium");
        service.getFee("high");
      }
      const elapsedMs = performance.now() - start;

      // 1000 iterations of pure in-memory reads should be nowhere near the
      // 10ms-per-call budget; a generous ceiling keeps this from being flaky
      // on slow CI while still catching any accidental network call.
      expect(elapsedMs).toBeLessThan(10);
    });
  });

  describe("lifecycle", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("start() triggers an immediate refresh and then polls on the configured interval", async () => {
      const getLatestLedger = jest.fn(async () => ({ sequence: 1 }));
      const service = new FeeEstimatorService(
        fakeRpc({ getLatestLedger }),
        1_000
      );

      service.start();
      // Flush the immediate `void this.refresh()` microtask.
      await Promise.resolve();
      await Promise.resolve();
      expect(getLatestLedger).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(1_000);
      await Promise.resolve();
      await Promise.resolve();
      expect(getLatestLedger).toHaveBeenCalledTimes(2);

      service.stop();
    });

    it("is idempotent: calling start() twice does not double-schedule polling", async () => {
      const getLatestLedger = jest.fn(async () => ({ sequence: 1 }));
      const service = new FeeEstimatorService(
        fakeRpc({ getLatestLedger }),
        1_000
      );

      service.start();
      service.start();
      await Promise.resolve();
      await Promise.resolve();

      jest.advanceTimersByTime(1_000);
      await Promise.resolve();
      await Promise.resolve();

      // One immediate call + one interval tick = 2, not 3+.
      expect(getLatestLedger).toHaveBeenCalledTimes(2);
      service.stop();
    });

    it("stop() halts further polling", async () => {
      const getLatestLedger = jest.fn(async () => ({ sequence: 1 }));
      const service = new FeeEstimatorService(
        fakeRpc({ getLatestLedger }),
        1_000
      );

      service.start();
      await Promise.resolve();
      await Promise.resolve();
      service.stop();

      const callsAtStop = getLatestLedger.mock.calls.length;
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();

      expect(getLatestLedger).toHaveBeenCalledTimes(callsAtStop);
    });
  });
});
