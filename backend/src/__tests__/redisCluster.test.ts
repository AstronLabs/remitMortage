// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("ioredis", () => {
  const mockCluster = {
    on: jest.fn().mockReturnThis(),
    once: jest.fn().mockReturnThis(),
    connect: jest.fn(),
    disconnect: jest.fn(),
    quit: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue("PONG"),
    cluster: jest.fn().mockResolvedValue(undefined),
    nodes: jest.fn().mockReturnValue([]),
    status: "ready",
    options: {},
  };

  const mockRedis = {
    on: jest.fn().mockReturnThis(),
    once: jest.fn().mockReturnThis(),
    connect: jest.fn(),
    disconnect: jest.fn(),
    quit: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue("PONG"),
    status: "ready",
  };

  return {
    Cluster: jest.fn(() => mockCluster),
    __esModule: true,
    default: jest.fn(() => mockRedis),
  };
});

import { isClusterMode, getClusterStatus, clusterHealthCheck, closeCluster, initializeRedisCluster } from "../services/redisCluster.js";

describe("Redis Cluster Connection Handler", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  describe("isClusterMode", () => {
    it("returns false when REDIS_CLUSTER_ENABLED is not set", () => {
      delete process.env.REDIS_CLUSTER_ENABLED;
      const result = isClusterMode();
      expect(result).toBe(false);
    });

    it("returns true when REDIS_CLUSTER_ENABLED=true and nodes configured", () => {
      process.env.REDIS_CLUSTER_ENABLED = "true";
      process.env.REDIS_CLUSTER_NODES = "localhost:6379,localhost:6380";
      const result = isClusterMode();
      expect(result).toBe(true);
    });

    it("returns false when REDIS_CLUSTER_ENABLED=true but no nodes configured", () => {
      process.env.REDIS_CLUSTER_ENABLED = "true";
      delete process.env.REDIS_CLUSTER_NODES;
      const result = isClusterMode();
      expect(result).toBe(false);
    });
  });

  describe("getClusterStatus", () => {
    it("returns 'none' mode when no client initialized", () => {
      const status = getClusterStatus();
      expect(status).toEqual({ mode: "none", connected: false, nodeCount: 0 });
    });
  });

  describe("clusterHealthCheck", () => {
    it("returns unhealthy when no client initialized", async () => {
      const result = await clusterHealthCheck();
      expect(result.ok).toBe(false);
      expect(result.mode).toBe("none");
    });
  });

  describe("closeCluster", () => {
    it("handles closing when no client exists", async () => {
      await expect(closeCluster()).resolves.toBeUndefined();
    });
  });
});
