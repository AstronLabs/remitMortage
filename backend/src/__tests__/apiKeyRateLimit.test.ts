// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Plan-tiered API key rate limits (issue #1106).
 *
 * Runs the real `requireScopedApiKey` → `apiKeyRateLimiter` chain against a
 * mocked key table so the plan is read exactly the way production reads it:
 * fresh from the database on every request.
 */

jest.mock("../services/db.js", () => ({
  prisma: { apiKey: { findUnique: jest.fn() } },
}));

import express from "express";
import request from "supertest";
import { prisma } from "../services/db.js";
import { requireScopedApiKey } from "../middleware/apiKeyAuth.js";
import {
  apiKeyRateLimiter,
  ApiKeyRateLimitStore,
  loadApiKeyRateLimitConfig,
  lowestTierPlan,
  parsePlanRateLimits,
  resolveApiKeyRateLimit,
  DEFAULT_API_KEY_RATE_LIMIT_TIERS,
  type ApiKeyRateLimitConfig,
} from "../middleware/apiKeyRateLimit.js";

const findUnique = prisma.apiKey.findUnique as jest.Mock;

const config: ApiKeyRateLimitConfig = {
  windowMs: 60_000,
  tiers: { free: { max: 2 }, pro: { max: 5 } },
  fallbackPlan: "free",
};

/** Key rows keyed by token; mutate `plan` to simulate a plan change. */
const keys: Record<string, { id: string; key: string; plan: string; scopes: string[]; revoked: boolean }> = {};

function buildApp(store: ApiKeyRateLimitStore) {
  const app = express();
  app.get("/data", requireScopedApiKey("export:transactions"), apiKeyRateLimiter(config, store), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

function call(app: express.Express, token: string) {
  return request(app).get("/data").set("Authorization", `Bearer ${token}`);
}

beforeEach(() => {
  findUnique.mockReset();
  findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
    const row = keys[where.key];
    return row ? { ...row } : null;
  });
  for (const token of Object.keys(keys)) delete keys[token];
  keys["tok-free"] = { id: "key-free", key: "tok-free", plan: "free", scopes: ["export:transactions"], revoked: false };
  keys["tok-pro"] = { id: "key-pro", key: "tok-pro", plan: "pro", scopes: ["export:transactions"], revoked: false };
});

describe("plan tier configuration", () => {
  it("parses plan=requests pairs and ignores malformed entries", () => {
    expect(parsePlanRateLimits("free=60, pro=600,bad,x=-1,=4")).toEqual({
      free: { max: 60 },
      pro: { max: 600 },
    });
    expect(parsePlanRateLimits(undefined)).toEqual({});
  });

  it("uses the built-in tiers by default and the env override when set", () => {
    const defaults = loadApiKeyRateLimitConfig({});
    expect(defaults.tiers).toEqual(DEFAULT_API_KEY_RATE_LIMIT_TIERS);
    expect(defaults.windowMs).toBe(60_000);
    expect(defaults.fallbackPlan).toBe("free");

    const overridden = loadApiKeyRateLimitConfig({
      API_KEY_RATE_LIMIT_BY_PLAN: "starter=10,scale=100",
      API_KEY_RATE_LIMIT_WINDOW_MS: "1000",
    });
    expect(overridden.tiers).toEqual({ starter: { max: 10 }, scale: { max: 100 } });
    expect(overridden.windowMs).toBe(1000);
    expect(overridden.fallbackPlan).toBe("starter");
  });

  it("falls back to the lowest tier for an unrecognized or missing plan", () => {
    expect(lowestTierPlan({ big: { max: 9 }, small: { max: 1 } })).toBe("small");
    expect(resolveApiKeyRateLimit(config, "pro")).toEqual({ plan: "pro", max: 5 });
    expect(resolveApiKeyRateLimit(config, "default")).toEqual({ plan: "free", max: 2 });
    expect(resolveApiKeyRateLimit(config, undefined)).toEqual({ plan: "free", max: 2 });
    // Prototype keys must not be mistaken for a configured plan.
    expect(resolveApiKeyRateLimit(config, "toString")).toEqual({ plan: "free", max: 2 });
  });
});

describe("apiKeyRateLimiter", () => {
  it("gives two keys on different plans their own plan's limit", async () => {
    const app = buildApp(new ApiKeyRateLimitStore(config.windowMs));

    const freeFirst = await call(app, "tok-free");
    expect(freeFirst.status).toBe(200);
    expect(freeFirst.headers["ratelimit-limit"]).toBe("2");
    expect(freeFirst.headers["ratelimit-remaining"]).toBe("1");
    expect(freeFirst.headers["x-ratelimit-plan"]).toBe("free");

    await call(app, "tok-free");
    const freeBlocked = await call(app, "tok-free");
    expect(freeBlocked.status).toBe(429);
    expect(freeBlocked.body).toMatchObject({ error: "rate_limit_exceeded", plan: "free", limit: 2 });
    expect(Number(freeBlocked.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(freeBlocked.headers["ratelimit-remaining"]).toBe("0");

    // The pro key is unaffected by the free key's exhaustion and gets 5.
    for (let i = 1; i <= 5; i++) {
      const res = await call(app, "tok-pro");
      expect(res.status).toBe(200);
      expect(res.headers["ratelimit-limit"]).toBe("5");
      expect(res.headers["ratelimit-remaining"]).toBe(String(5 - i));
    }
    expect((await call(app, "tok-pro")).status).toBe(429);
  });

  it("applies the lowest tier to a key with an unrecognized plan", async () => {
    keys["tok-legacy"] = { id: "key-legacy", key: "tok-legacy", plan: "default", scopes: ["*"], revoked: false };
    const app = buildApp(new ApiKeyRateLimitStore(config.windowMs));

    const res = await call(app, "tok-legacy");
    expect(res.headers["ratelimit-limit"]).toBe("2");
    expect(res.headers["x-ratelimit-plan"]).toBe("free");
  });

  it("applies a plan change on the key's very next request", async () => {
    const app = buildApp(new ApiKeyRateLimitStore(config.windowMs));

    await call(app, "tok-free");
    await call(app, "tok-free");
    expect((await call(app, "tok-free")).status).toBe(429);

    // Upgrade the key in the "database"; nothing else is reset or reloaded.
    keys["tok-free"].plan = "pro";

    const next = await call(app, "tok-free");
    expect(next.status).toBe(200);
    expect(next.headers["ratelimit-limit"]).toBe("5");
    expect(next.headers["x-ratelimit-plan"]).toBe("pro");
    // The window's count carries over: 4 requests used of the new 5.
    expect(next.headers["ratelimit-remaining"]).toBe("1");

    // A downgrade is just as immediate.
    keys["tok-free"].plan = "free";
    const downgraded = await call(app, "tok-free");
    expect(downgraded.status).toBe(429);
    expect(downgraded.headers["ratelimit-limit"]).toBe("2");
  });

  it("resets each key's count when its window rolls over", async () => {
    let now = 0;
    const store = new ApiKeyRateLimitStore(config.windowMs, () => now);
    const app = buildApp(store);

    await call(app, "tok-free");
    await call(app, "tok-free");
    expect((await call(app, "tok-free")).status).toBe(429);

    now += config.windowMs;
    const afterRollover = await call(app, "tok-free");
    expect(afterRollover.status).toBe(200);
    expect(afterRollover.headers["ratelimit-remaining"]).toBe("1");
  });

  it("passes through when no API key was resolved upstream", async () => {
    const app = express();
    app.get("/open", apiKeyRateLimiter(config), (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/open");
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-limit"]).toBeUndefined();
  });
});
