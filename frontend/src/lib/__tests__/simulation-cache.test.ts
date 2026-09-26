// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  buildSimulationCacheKey,
  clearSimulationCache,
  readCachedSimulation,
  SIMULATION_CACHE_PREFIX,
  SIMULATION_CACHE_TTL_MS,
  writeCachedSimulation,
} from "../simulation-cache";
import type { SimulationEstimate } from "../soroban-client";

const ESTIMATE: SimulationEstimate = {
  minResourceFeeStroops: "51234",
  instructions: "1200000",
  readBytes: "3200",
  writeBytes: "512",
  readEntries: "4",
  writeEntries: "2",
};

const KEY_PARTS = {
  contractId: "CCONTRACT",
  method: "deposit",
  account: "GACCOUNT",
  args: ["1000000"],
};

describe("simulation cache", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("builds a key from the call shape", () => {
    const key = buildSimulationCacheKey(KEY_PARTS);
    expect(key).toBe(`${SIMULATION_CACHE_PREFIX}CCONTRACT:deposit:GACCOUNT:1000000`);
  });

  it("distinguishes different accounts and arguments", () => {
    const a = buildSimulationCacheKey(KEY_PARTS);
    const b = buildSimulationCacheKey({ ...KEY_PARTS, account: "GOTHER" });
    const c = buildSimulationCacheKey({ ...KEY_PARTS, args: ["2000000"] });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("round-trips an estimate", () => {
    const key = buildSimulationCacheKey(KEY_PARTS);
    writeCachedSimulation(key, ESTIMATE);
    expect(readCachedSimulation(key)).toEqual(ESTIMATE);
  });

  it("returns null for a missing key", () => {
    expect(readCachedSimulation("rm_sim_footprint:missing")).toBeNull();
  });

  it("evicts entries past the TTL", () => {
    const key = buildSimulationCacheKey(KEY_PARTS);
    const cachedAt = 1_000_000;
    writeCachedSimulation(key, ESTIMATE, cachedAt);

    expect(readCachedSimulation(key, cachedAt + SIMULATION_CACHE_TTL_MS - 1)).toEqual(
      ESTIMATE
    );
    expect(readCachedSimulation(key, cachedAt + SIMULATION_CACHE_TTL_MS + 1)).toBeNull();
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it("discards corrupted entries", () => {
    const key = buildSimulationCacheKey(KEY_PARTS);
    sessionStorage.setItem(key, "{not json");
    expect(readCachedSimulation(key)).toBeNull();
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it("clears only its own keys", () => {
    const key = buildSimulationCacheKey(KEY_PARTS);
    writeCachedSimulation(key, ESTIMATE);
    sessionStorage.setItem("unrelated", "keep me");

    clearSimulationCache();

    expect(readCachedSimulation(key)).toBeNull();
    expect(sessionStorage.getItem("unrelated")).toBe("keep me");
  });
});
