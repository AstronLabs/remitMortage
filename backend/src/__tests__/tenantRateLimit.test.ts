// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { tenantRateLimitMiddleware, tenantRequestLimit } from "../middleware/tenantRateLimit.js";
import { EntitlementService } from "../services/entitlements.js";
import { getCurrentTenant, type TenantBranding } from "../services/tenant.js";
import { tenantRateLimitUsage } from "../services/metrics.js";

jest.mock("../services/tenant.js", () => ({
  DEFAULT_TENANT_ID: "default",
  getCurrentTenant: jest.fn(),
}));

function testTenant(id: string): TenantBranding {
  return {
    id,
    name: id,
    legalEntity: id,
    logoUrl: null,
    colors: { header: "#000", primary: "#fff" },
    senderDomain: "example.com",
    senderEmail: "no-reply@example.com",
    supportEmail: null,
    hosts: [],
  };
}

describe("tenantRateLimitMiddleware", () => {
  const getTenantMock = jest.mocked(getCurrentTenant);

  beforeEach(() => {
    getTenantMock.mockReturnValue(testTenant("default"));
  });

  function buildApp() {
    const app = express();
    app.use((req, _res, next) => {
      const tenantId = String(req.headers["x-test-tenant"] ?? "tenant-default");
      getTenantMock.mockReturnValue(testTenant(tenantId));
      next();
    });
    app.get(
      "/resource",
      (req, _res, next) => {
        (req as AuthenticatedRequest).user = { walletAddress: "GTEST", network: "testnet" };
        next();
      },
      tenantRateLimitMiddleware,
      (_req, res) => res.json({ ok: true })
    );
    return app;
  }

  it("limits one tenant by its plan budget while leaving other tenants unaffected", async () => {
    const app = buildApp();

    for (let i = 0; i < 60; i++) {
      const allowed = await request(app).get("/resource").set("X-Test-Tenant", "tenant-a");
      expect(allowed.status).toBe(200);
    }

    const blocked = await request(app).get("/resource").set("X-Test-Tenant", "tenant-a");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({
      error: "tenant_rate_limit_exceeded",
      tenantId: "tenant-a",
      limit: 60,
      statusCode: 429,
    });
    expect(blocked.body.resetAt).toEqual(expect.any(String));
    expect(blocked.headers["retry-after"]).toEqual(expect.any(String));
    expect(blocked.headers["x-tenant-ratelimit-remaining"]).toBe("0");

    const otherTenant = await request(app).get("/resource").set("X-Test-Tenant", "tenant-b");
    expect(otherTenant.status).toBe(200);
    expect(otherTenant.headers["x-tenant-ratelimit-remaining"]).toBe("59");

    const usage = await tenantRateLimitUsage.get();
    expect(usage.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: { tenant_id: "tenant-a", plan: "FREE" },
          value: 61,
        }),
        expect.objectContaining({
          labels: { tenant_id: "tenant-b", plan: "FREE" },
          value: 1,
        }),
      ])
    );
  });

  it("does not meter unauthenticated requests", async () => {
    const app = express();
    app.get("/resource", tenantRateLimitMiddleware, (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/resource");
    expect(res.status).toBe(200);
    expect(res.headers["x-tenant-ratelimit-limit"]).toBeUndefined();
  });

  it("uses per-plan request limits while capping one tenant below shared capacity", () => {
    const plans = new EntitlementService();
    expect(tenantRequestLimit("free-tenant", plans)).toEqual({ plan: "FREE", limit: 60 });

    plans.assignPlan("pro-tenant", "PRO");
    expect(tenantRequestLimit("pro-tenant", plans)).toEqual({ plan: "PRO", limit: 240 });

    plans.assignPlan("enterprise-tenant", "ENTERPRISE");
    expect(tenantRequestLimit("enterprise-tenant", plans)).toEqual({
      plan: "ENTERPRISE",
      limit: 240,
    });
  });
});
