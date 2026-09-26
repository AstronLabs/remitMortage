// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { computeJuniorApyBps } from "../services/soroban.js";

describe("computeJuniorApyBps", () => {
  it("gives the junior tranche the residual interest budget after paying the senior rate", () => {
    // Pool charges borrowers 10% (1000 bps), senior gets a fixed 4% (400 bps).
    // 600 senior + 400 junior deposited. Total interest budget = 10% * 1000 = 100.
    // Senior takes 4% * 600 = 24. Remaining 76 goes to junior's 400 -> 19% (1900 bps).
    expect(computeJuniorApyBps(1000, 400, 600, 400)).toBe(1900);
  });

  it("returns 0 when there is no junior liquidity", () => {
    expect(computeJuniorApyBps(1000, 400, 600, 0)).toBe(0);
  });

  it("returns 0 when nothing is deposited at all", () => {
    expect(computeJuniorApyBps(1000, 400, 0, 0)).toBe(0);
  });

  it("floors at 0 rather than going negative if the senior rate exceeds the pool rate", () => {
    // Pathological input: senior rate somehow exceeds the base pool rate.
    expect(computeJuniorApyBps(400, 1000, 600, 400)).toBe(0);
  });
});

describe("GET /api/analytics/pool-rates", () => {
  const ORIGINAL_ENV = process.env.LENDING_POOL_CONTRACT_ID;

  afterEach(() => {
    process.env.LENDING_POOL_CONTRACT_ID = ORIGINAL_ENV;
    jest.resetModules();
  });

  it("returns 503 when the lending pool contract is not configured", async () => {
    jest.resetModules();
    delete process.env.LENDING_POOL_CONTRACT_ID;

    jest.doMock("../services/soroban.js", () => ({
      getLendingPoolRates: jest.fn(),
    }));
    // routes/analytics.ts also imports services/analytics.js, which transitively
    // reaches services/db.js (`new PrismaClient()`); mocked out here purely to
    // isolate these pool-rates tests from that unrelated, pre-existing
    // Prisma-client-construction issue (also hit by analytics.test.ts /
    // contractorUpload.test.ts on main, independent of this change).
    jest.doMock("../services/analytics.js", () => ({
      getProtocolOverview: jest.fn(),
      getLoanPerformance: jest.fn(),
      getDisbursementProgress: jest.fn(),
      getMonthlyVolume: jest.fn(),
    }));
    jest.doMock("../middleware/cache.js", () => ({
      cacheMiddleware: () => (_req: any, _res: any, next: any) => next(),
    }));

    const express = require("express");
    const request = require("supertest");
    const { analyticsRouter } = require("../routes/analytics.js");

    const app = express();
    app.use("/api/analytics", analyticsRouter);

    const res = await request(app).get("/api/analytics/pool-rates");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("not_configured");
  });

  it("returns live rates when the contract read succeeds", async () => {
    jest.resetModules();
    process.env.LENDING_POOL_CONTRACT_ID = "CPOOLCONTRACT";

    const mockRates = {
      poolApyBps: 1000,
      seniorApyBps: 400,
      juniorApyBps: 1900,
      seniorLiquidity: "600",
      juniorLiquidity: "400",
    };
    jest.doMock("../services/soroban.js", () => ({
      getLendingPoolRates: jest.fn().mockResolvedValue(mockRates),
    }));
    jest.doMock("../services/analytics.js", () => ({
      getProtocolOverview: jest.fn(),
      getLoanPerformance: jest.fn(),
      getDisbursementProgress: jest.fn(),
      getMonthlyVolume: jest.fn(),
    }));
    jest.doMock("../middleware/cache.js", () => ({
      cacheMiddleware: () => (_req: any, _res: any, next: any) => next(),
    }));

    const express = require("express");
    const request = require("supertest");
    const { analyticsRouter } = require("../routes/analytics.js");

    const app = express();
    app.use("/api/analytics", analyticsRouter);

    const res = await request(app).get("/api/analytics/pool-rates");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockRates);
  });

  it("returns 502 when the on-chain read fails", async () => {
    jest.resetModules();
    process.env.LENDING_POOL_CONTRACT_ID = "CPOOLCONTRACT";

    jest.doMock("../services/soroban.js", () => ({
      getLendingPoolRates: jest.fn().mockRejectedValue(new Error("RPC unreachable")),
    }));
    jest.doMock("../services/analytics.js", () => ({
      getProtocolOverview: jest.fn(),
      getLoanPerformance: jest.fn(),
      getDisbursementProgress: jest.fn(),
      getMonthlyVolume: jest.fn(),
    }));
    jest.doMock("../middleware/cache.js", () => ({
      cacheMiddleware: () => (_req: any, _res: any, next: any) => next(),
    }));

    const express = require("express");
    const request = require("supertest");
    const { analyticsRouter } = require("../routes/analytics.js");

    const app = express();
    app.use("/api/analytics", analyticsRouter);

    const res = await request(app).get("/api/analytics/pool-rates");
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("on_chain_unavailable");
  });
});
