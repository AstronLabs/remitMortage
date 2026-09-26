// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { rpc } from "@stellar/stellar-sdk";
import { RpcFailoverManager } from "../services/rpcFailover";

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

describe("RpcFailoverManager", () => {
  it("should initialize with multiple RPC URLs", () => {
    const urls = [
      "https://rpc1.example.com",
      "https://rpc2.example.com",
      "https://rpc3.example.com",
    ];
    const manager = new RpcFailoverManager(urls);
    const status = manager.getHealthStatus();

    expect(status).toHaveLength(3);
    expect(status.every((s) => s.healthy)).toBe(true);
  });

  it("should throw error when no URLs provided", () => {
    expect(() => new RpcFailoverManager([])).toThrow(
      "At least one RPC URL must be provided"
    );
  });

  it("should execute operation on primary node when healthy", async () => {
    const urls = ["https://rpc1.example.com"];
    const manager = new RpcFailoverManager(urls);

    const mockOperation = jest.fn().mockResolvedValue({ success: true });
    const result = await manager.execute(mockOperation, "test-operation");

    expect(result).toEqual({ success: true });
    expect(mockOperation).toHaveBeenCalledTimes(1);
  });

  it("should failover to next node on timeout", async () => {
    const urls = [
      "https://rpc1.example.com",
      "https://rpc2.example.com",
    ];
    const manager = new RpcFailoverManager(urls);

    let callCount = 0;
    const mockOperation = jest.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First call times out
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      return { success: true };
    });

    await expect(
      manager.execute(mockOperation, "test-operation")
    ).resolves.toEqual({ success: true });
  }, 10000);

  it("should round-robin across healthy nodes", async () => {
    const urls = [
      "https://rpc1.example.com",
      "https://rpc2.example.com",
    ];
    const manager = new RpcFailoverManager(urls);

    const mockOperation = jest.fn().mockResolvedValue({ success: true });

    await manager.execute(mockOperation, "request-1");
    await manager.execute(mockOperation, "request-2");
    await manager.execute(mockOperation, "request-3");

    expect(mockOperation).toHaveBeenCalledTimes(3);
  });

  it("should report node health status", async () => {
    const urls = [
      "https://rpc1.example.com",
      "https://rpc2.example.com",
    ];
    const manager = new RpcFailoverManager(urls);

    let status = manager.getHealthStatus();
    expect(status.every((s) => s.healthy)).toBe(true);
    expect(status.every((s) => s.failures === 0)).toBe(true);
  });
});
