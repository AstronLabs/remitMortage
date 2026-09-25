// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Chaos / fault-injection tests for the Redis dependency (issue #479).
 *
 * These simulate a Redis outage *mid-run* by flipping a fault flag on the
 * mocked client so every operation rejects (as it would when the container is
 * killed/paused), then flipping it back to model the container recovering.
 *
 * They assert the two resilience guarantees from the issue:
 *   1. Cache reads/writes degrade gracefully during an outage — callers get a
 *      cache miss (null) / no-op instead of an unhandled exception, so request
 *      handlers can fall through to the source of truth and never crash.
 *   2. Once Redis recovers, the same client resumes normal operation without a
 *      restart (ioredis keeps the connection object and auto-reconnects).
 *
 * The companion integration harness (scripts/chaos/redis-postgres-chaos.sh)
 * exercises the same guarantees end-to-end by pausing the real Redis and
 * Postgres containers against a running backend.
 */

// Shared, mutable fault state the mocked client reads on every call. The
// `mock` prefix lets jest reference it inside the hoisted factory below.
const mockRedisState = {
  outage: false,
  store: new Map<string, string>(),
};

jest.mock("ioredis", () => {
  const OUTAGE_ERROR = () => new Error("connect ECONNREFUSED (simulated outage)");

  class FakeRedis {
    on() {
      return this;
    }
    async ping() {
      if (mockRedisState.outage) throw OUTAGE_ERROR();
      return "PONG";
    }
    async get(key: string) {
      if (mockRedisState.outage) throw OUTAGE_ERROR();
      return mockRedisState.store.get(key) ?? null;
    }
    async setex(key: string, _ttl: number, value: string) {
      if (mockRedisState.outage) throw OUTAGE_ERROR();
      mockRedisState.store.set(key, value);
      return "OK";
    }
    async del(...keys: string[]) {
      if (mockRedisState.outage) throw OUTAGE_ERROR();
      let removed = 0;
      for (const key of keys) {
        if (mockRedisState.store.delete(key)) removed += 1;
      }
      return removed;
    }
    async keys(_pattern: string) {
      if (mockRedisState.outage) throw OUTAGE_ERROR();
      return [...mockRedisState.store.keys()];
    }
    async quit() {
      return "OK";
    }
  }

  return { __esModule: true, default: FakeRedis };
});

import {
  initializeRedis,
  getCacheValue,
  setCacheValue,
  deleteCacheValue,
  getRedisClient,
} from "../../services/redis";

beforeEach(() => {
  mockRedisState.outage = false;
  mockRedisState.store.clear();
  process.env.REDIS_URL = "redis://localhost:6379";
});

describe("Redis chaos: graceful degradation and recovery", () => {
  it("connects and round-trips cache values while healthy", async () => {
    const client = await initializeRedis();
    expect(client).not.toBeNull();

    await setCacheValue("k", { hello: "world" }, 60);
    expect(await getCacheValue("k")).toEqual({ hello: "world" });
  });

  it("degrades to cache-miss without throwing during an outage", async () => {
    await initializeRedis();
    await setCacheValue("k", { hello: "world" }, 60);

    // ── Kill Redis mid-run ──────────────────────────────────────────────
    mockRedisState.outage = true;

    // Reads must resolve to null (a cache miss) rather than reject, so the
    // caller falls through to the source of truth instead of 500-ing.
    await expect(getCacheValue("k")).resolves.toBeNull();
    // Writes/deletes must be silent no-ops, never throwing.
    await expect(setCacheValue("k2", { a: 1 }, 60)).resolves.toBeUndefined();
    await expect(deleteCacheValue("k")).resolves.toBeUndefined();
  });

  it("resumes normal operation once Redis recovers", async () => {
    await initializeRedis();

    mockRedisState.outage = true;
    await expect(getCacheValue("k")).resolves.toBeNull();

    // ── Redis comes back online ─────────────────────────────────────────
    mockRedisState.outage = false;

    // The same client object is reused (no restart needed) and works again.
    expect(getRedisClient()).not.toBeNull();
    await setCacheValue("k", { recovered: true }, 60);
    await expect(getCacheValue("k")).resolves.toEqual({ recovered: true });
  });

  it("survives repeated outage/recovery cycles without crashing", async () => {
    await initializeRedis();

    for (let cycle = 0; cycle < 3; cycle += 1) {
      mockRedisState.outage = true;
      await expect(getCacheValue(`c${cycle}`)).resolves.toBeNull();
      await expect(setCacheValue(`c${cycle}`, cycle, 60)).resolves.toBeUndefined();

      mockRedisState.outage = false;
      await setCacheValue(`c${cycle}`, cycle, 60);
      await expect(getCacheValue(`c${cycle}`)).resolves.toBe(cycle);
    }
  });
});
