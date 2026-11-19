// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  FaultInjectionError,
  clearAllFaults,
  clearFault,
  faultCount,
  isFaultInjectionEnabled,
  maybeInjectFault,
  registerFault,
  withFaultInjection,
} from "../services/faultInjection";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  clearAllFaults();
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe("isFaultInjectionEnabled", () => {
  it("is enabled everywhere except production", () => {
    for (const env of ["development", "test", "staging"]) {
      process.env.NODE_ENV = env;
      expect(isFaultInjectionEnabled()).toBe(true);
    }
  });

  it("is disabled in production", () => {
    process.env.NODE_ENV = "production";
    expect(isFaultInjectionEnabled()).toBe(false);
  });
});

describe("fault injection outside production", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
  });

  it("is a transparent pass-through when no fault is armed", async () => {
    await expect(withFaultInjection("dependency", async () => "ok")).resolves.toBe("ok");
    expect(faultCount()).toBe(0);
  });

  it("forces a dependency call to fail", async () => {
    registerFault("dependency", { message: "dependency unavailable" });

    await expect(maybeInjectFault("dependency")).rejects.toBeInstanceOf(FaultInjectionError);
    await expect(maybeInjectFault("dependency")).rejects.toThrow("dependency unavailable");
  });

  it("returns a specific error with a code and HTTP status", async () => {
    registerFault("dependency", { message: "rate limited", code: "RATE_LIMIT", status: 429 });

    await expect(maybeInjectFault("dependency")).rejects.toMatchObject({
      code: "RATE_LIMIT",
      status: 429,
      response: { status: 429 },
    });
  });

  it("simulates a timeout after the requested delay", async () => {
    registerFault("dependency", { mode: "timeout", delayMs: 5 });

    const startedAt = Date.now();
    await expect(maybeInjectFault("dependency")).rejects.toThrow(/timeout/i);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4);
  });

  it("injects only the configured number of times", async () => {
    registerFault("dependency", { times: 2 });

    await expect(maybeInjectFault("dependency")).rejects.toThrow();
    await expect(maybeInjectFault("dependency")).rejects.toThrow();
    await expect(maybeInjectFault("dependency")).resolves.toBeUndefined();
  });

  it("stops injecting once a fault is cleared", async () => {
    registerFault("dependency", {});
    expect(faultCount()).toBe(1);

    clearFault("dependency");

    expect(faultCount()).toBe(0);
    await expect(maybeInjectFault("dependency")).resolves.toBeUndefined();
  });

  it("only faults the dependency it was armed for", async () => {
    registerFault("payment.gateway", {});

    await expect(maybeInjectFault("payment.gateway")).rejects.toThrow();
    await expect(maybeInjectFault("soroban.rpc")).resolves.toBeUndefined();
  });
});

describe("fault injection in production", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });

  it("ignores registration and never injects", async () => {
    registerFault("dependency", { message: "boom" });

    expect(faultCount()).toBe(0);
    await expect(maybeInjectFault("dependency")).resolves.toBeUndefined();
    await expect(withFaultInjection("dependency", async () => "ok")).resolves.toBe("ok");
  });

  it("stays inert even when a fault was armed before switching to production", async () => {
    process.env.NODE_ENV = "test";
    registerFault("dependency", { message: "boom" });
    expect(faultCount()).toBe(1);

    process.env.NODE_ENV = "production";

    expect(faultCount()).toBe(0);
    await expect(maybeInjectFault("dependency")).resolves.toBeUndefined();
  });
});
