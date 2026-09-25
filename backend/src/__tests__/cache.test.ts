// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Request, Response, NextFunction } from "express";
import { cacheMiddleware } from "../middleware/cache.js";
import { getCacheValue, setCacheValue } from "../services/redis.js";

jest.mock("../services/redis.js", () => ({
  getCacheValue: jest.fn(),
  setCacheValue: jest.fn(),
  deleteCacheByPattern: jest.fn(),
}));

jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe("Cache Middleware", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      method: "GET",
      originalUrl: "/api/analytics/overview",
    };
    res = {
      statusCode: 200,
      json: jest.fn(),
    };
    next = jest.fn();
  });

  it("should bypass cache on non-GET requests", async () => {
    req.method = "POST";
    const middleware = cacheMiddleware(60);
    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(getCacheValue).not.toHaveBeenCalled();
  });

  it("should return cached response if hit", async () => {
    const cachedData = { tvl: 1000 };
    (getCacheValue as jest.Mock).mockResolvedValue(cachedData);

    const middleware = cacheMiddleware(60);
    await middleware(req as Request, res as Response, next);

    expect(getCacheValue).toHaveBeenCalledWith("analytics:/api/analytics/overview");
    expect(res.json).toHaveBeenCalledWith(cachedData);
    expect(next).not.toHaveBeenCalled();
  });

  it("should proceed to next() and intercept res.json on cache miss", async () => {
    (getCacheValue as jest.Mock).mockResolvedValue(null);
    (setCacheValue as jest.Mock).mockResolvedValue(undefined);

    const middleware = cacheMiddleware(60);
    await middleware(req as Request, res as Response, next);

    expect(getCacheValue).toHaveBeenCalledWith("analytics:/api/analytics/overview");
    expect(next).toHaveBeenCalledTimes(1);

    // Now call res.json
    const body = { new: "data" };
    (res as any).json(body);

    expect(setCacheValue).toHaveBeenCalledWith("analytics:/api/analytics/overview", body, 60);
  });

  it("should proceed gracefully on getCacheValue error", async () => {
    (getCacheValue as jest.Mock).mockRejectedValue(new Error("Redis disconnected"));
    
    const middleware = cacheMiddleware(60);
    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
