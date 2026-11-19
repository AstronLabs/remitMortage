// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { RpcFailoverManager } from "../services/rpcFailover";
import { FailoverKycProvider } from "../services/kycProviderFailover";
import type { OcrProvider, OcrResult } from "../services/ocrService";
import {
  FAULT_INJECTION_KEYS,
  clearAllFaults,
  clearFault,
  registerFault,
} from "../services/faultInjection";

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

afterEach(() => clearAllFaults());

describe("RPC resilience driven by fault injection", () => {
  const urls = ["https://rpc1.example.com", "https://rpc2.example.com"];
  const operation = async () => ({ ok: true });

  it("retries the next node when the first attempt is faulted", async () => {
    const manager = new RpcFailoverManager(urls);
    registerFault(FAULT_INJECTION_KEYS.rpc, { times: 1 });

    const result = await manager.execute(operation, "test-operation");

    expect(result).toEqual({ ok: true });
    const status = manager.getHealthStatus();
    expect(status[0].failures).toBe(1);
    expect(status[1].failures).toBe(0);
  });

  it("fails on every node when the dependency is down", async () => {
    const manager = new RpcFailoverManager(urls);
    registerFault(FAULT_INJECTION_KEYS.rpc, { message: "rpc unavailable" });

    await expect(manager.execute(operation, "test-operation")).rejects.toThrow(
      /failed on all 2 available RPC nodes/
    );
  });

  it("opens the circuit after repeated failures and skips the unhealthy nodes", async () => {
    const manager = new RpcFailoverManager(urls);
    registerFault(FAULT_INJECTION_KEYS.rpc, {});

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(manager.execute(operation, "test-operation")).rejects.toThrow();
    }

    expect(manager.getHealthStatus().every((node) => !node.healthy)).toBe(true);

    // With the breaker open every node is skipped, so nothing is even attempted.
    await expect(manager.execute(operation, "test-operation")).rejects.toThrow(
      /failed on all 0 available RPC nodes/
    );
  });
});

describe("KYC resilience driven by fault injection", () => {
  const DOC = Buffer.from("document");

  const ok = (name: string): OcrResult => ({
    fields: { name, idNumber: null, address: null },
    success: true,
    error: null,
  });

  const provider = (name: string): OcrProvider => ({ extract: async () => ok(name) });

  it("activates the circuit breaker after the primary keeps failing, then recovers", async () => {
    const failover = new FailoverKycProvider(provider("PRIMARY"), provider("BACKUP"), {
      failureThreshold: 3,
      cooldownMs: 0,
    });

    registerFault(FAULT_INJECTION_KEYS.kycPrimary, { message: "primary down" });

    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await failover.extract(DOC, "application/pdf");
      expect(result.fields.name).toBe("BACKUP");
    }
    expect(failover.isFailoverActive()).toBe(true);

    // Once the fault is lifted the primary is probed again and recovers.
    clearFault(FAULT_INJECTION_KEYS.kycPrimary);
    const recovered = await failover.extract(DOC, "application/pdf");

    expect(recovered.fields.name).toBe("PRIMARY");
    expect(failover.isFailoverActive()).toBe(false);
  });

  it("returns a failure when both providers are faulted", async () => {
    const failover = new FailoverKycProvider(provider("PRIMARY"), provider("BACKUP"), {
      failureThreshold: 3,
      cooldownMs: 0,
    });
    registerFault(FAULT_INJECTION_KEYS.kycPrimary, {});
    registerFault(FAULT_INJECTION_KEYS.kycBackup, {});

    const result = await failover.extract(DOC, "application/pdf");

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/fault/i);
  });
});
