// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Tests for per-client API usage reports (issue #1053):
 *   - per-endpoint metering recorded alongside the existing period total,
 *   - the report's totals and per-endpoint breakdown,
 *   - that a key can never read another key's report.
 */

import express from "express";
import request from "supertest";

const mockUsageUpsert = jest.fn();
const mockUsageFindUnique = jest.fn();
const mockUsageFindMany = jest.fn();
const mockEndpointUpsert = jest.fn();
const mockEndpointFindMany = jest.fn();
const mockApiKeyFindUnique = jest.fn();

jest.mock("../services/db.js", () => ({
  prisma: {
    apiKeyUsage: {
      upsert: (...args: any[]) => mockUsageUpsert(...args),
      findUnique: (...args: any[]) => mockUsageFindUnique(...args),
      findMany: (...args: any[]) => mockUsageFindMany(...args),
    },
    apiKeyEndpointUsage: {
      upsert: (...args: any[]) => mockEndpointUpsert(...args),
      findMany: (...args: any[]) => mockEndpointFindMany(...args),
    },
    apiKey: { findUnique: (...args: any[]) => mockApiKeyFindUnique(...args) },
  },
}));

import { apiKeyUsageRouter } from "../routes/apiKeyUsage.js";
import {
  endpointLabel,
  getApiKeyUsageReport,
  recordApiKeyRequest,
} from "../middleware/apiKeyQuota.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("endpointLabel", () => {
  it("uses the matched route pattern so dynamic segments collapse to one label", () => {
    const req = {
      method: "get",
      baseUrl: "/api/exports",
      path: "/transactions",
      route: { path: "/transactions" },
    } as any;
    expect(endpointLabel(req)).toBe("GET /api/exports/transactions");
  });

  it("falls back to the request path when no route matched", () => {
    const req = { method: "post", baseUrl: "", path: "/api/loan/abc/approve" } as any;
    expect(endpointLabel(req)).toBe("POST /api/loan/abc/approve");
  });
});

describe("recordApiKeyRequest per-endpoint metering", () => {
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  const now = new Date("2026-01-02T00:00:00.000Z");

  beforeEach(() => {
    mockUsageUpsert.mockReset();
    mockEndpointUpsert.mockReset();
  });

  it("records a per-endpoint counter alongside the period total", async () => {
    mockUsageUpsert.mockResolvedValue({
      requestCount: 4,
      periodStart: createdAt,
      periodEnd: new Date(createdAt.getTime() + 30 * DAY_MS),
    });
    mockEndpointUpsert.mockResolvedValue({});

    const result = await recordApiKeyRequest(
      "key-1",
      createdAt,
      30,
      now,
      "GET /api/exports/transactions"
    );

    expect(result.requestCount).toBe(4);
    expect(mockEndpointUpsert).toHaveBeenCalledWith({
      where: {
        apiKeyId_periodStart_endpoint: {
          apiKeyId: "key-1",
          periodStart: createdAt,
          endpoint: "GET /api/exports/transactions",
        },
      },
      create: {
        apiKeyId: "key-1",
        periodStart: createdAt,
        endpoint: "GET /api/exports/transactions",
        requestCount: 1,
      },
      update: { requestCount: { increment: 1 } },
    });
  });

  it("writes no endpoint counter when no endpoint is given", async () => {
    mockUsageUpsert.mockResolvedValue({ requestCount: 1, periodStart: createdAt, periodEnd: createdAt });
    await recordApiKeyRequest("key-2", createdAt, 30, now);
    expect(mockEndpointUpsert).not.toHaveBeenCalled();
  });

  it("still returns the authoritative total when the endpoint write fails", async () => {
    mockUsageUpsert.mockResolvedValue({ requestCount: 9, periodStart: createdAt, periodEnd: createdAt });
    mockEndpointUpsert.mockRejectedValue(new Error("endpoint store down"));

    await expect(
      recordApiKeyRequest("key-3", createdAt, 30, now, "GET /x")
    ).resolves.toMatchObject({ requestCount: 9 });
  });
});

describe("getApiKeyUsageReport", () => {
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  const periodStart = createdAt;
  const periodEnd = new Date(createdAt.getTime() + 30 * DAY_MS);

  beforeEach(() => {
    mockUsageFindMany.mockReset();
    mockEndpointFindMany.mockReset();
  });

  it("totals the metering rows and breaks them down by endpoint", async () => {
    // Two billing periods in range, totalling 12 metered requests.
    mockUsageFindMany.mockResolvedValue([{ requestCount: 5 }, { requestCount: 7 }]);
    mockEndpointFindMany.mockResolvedValue([
      { endpoint: "GET /api/exports/transactions", requestCount: 3 },
      { endpoint: "GET /api/exports/transactions", requestCount: 2 },
      { endpoint: "POST /api/loans", requestCount: 7 },
    ]);

    const report = await getApiKeyUsageReport({
      apiKeyId: "key-1",
      keyCreatedAt: createdAt,
      periodDays: 30,
      since: periodStart,
      until: periodEnd,
      now: new Date("2026-01-10T00:00:00.000Z"),
    });

    expect(report.totalRequests).toBe(12);
    expect(report.byEndpoint).toEqual([
      { endpoint: "POST /api/loans", requestCount: 7 },
      { endpoint: "GET /api/exports/transactions", requestCount: 5 },
    ]);
    // The breakdown sums back to the metered total exactly.
    expect(report.byEndpoint.reduce((sum, e) => sum + e.requestCount, 0)).toBe(report.totalRequests);

    // Both queries are scoped strictly to the requested key.
    expect(mockUsageFindMany.mock.calls[0][0].where.apiKeyId).toBe("key-1");
    expect(mockEndpointFindMany.mock.calls[0][0].where.apiKeyId).toBe("key-1");
    const range = mockUsageFindMany.mock.calls[0][0].where.periodStart;
    expect(range.gte).toEqual(periodStart);
    expect(range.lte).toEqual(periodEnd);
  });

  it("defaults to the current billing period when no period is given", async () => {
    mockUsageFindMany.mockResolvedValue([]);
    mockEndpointFindMany.mockResolvedValue([]);

    const report = await getApiKeyUsageReport({
      apiKeyId: "key-1",
      keyCreatedAt: createdAt,
      periodDays: 30,
      now: createdAt,
    });

    const where = mockUsageFindMany.mock.calls[0][0].where.periodStart;
    expect(where.gte).toEqual(createdAt);
    expect(where.lte).toEqual(createdAt);
    expect(report.totalRequests).toBe(0);
    expect(report.byEndpoint).toEqual([]);
  });
});

describe("GET /api/keys/usage/report", () => {
  const app = express();
  app.use("/api/keys", apiKeyUsageRouter);

  const keyA = {
    id: "key-a",
    plan: "default",
    scopes: ["*"],
    revoked: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const keyB = {
    id: "key-b",
    plan: "default",
    scopes: ["*"],
    revoked: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  beforeEach(() => {
    mockApiKeyFindUnique.mockReset();
    mockUsageFindMany.mockReset();
    mockEndpointFindMany.mockReset();
  });

  it("requires an API key", async () => {
    const res = await request(app).get("/api/keys/usage/report");
    expect(res.status).toBe(401);
    expect(mockUsageFindMany).not.toHaveBeenCalled();
  });

  it("rejects a revoked or unknown key", async () => {
    mockApiKeyFindUnique.mockResolvedValue(null);
    const res = await request(app)
      .get("/api/keys/usage/report")
      .set("Authorization", "Bearer rm_unknown");
    expect(res.status).toBe(403);
  });

  it("reports the authenticated key's totals and per-endpoint breakdown", async () => {
    mockApiKeyFindUnique.mockResolvedValue(keyA);
    mockUsageFindMany.mockResolvedValue([{ requestCount: 4 }, { requestCount: 6 }]);
    mockEndpointFindMany.mockResolvedValue([
      { endpoint: "GET /api/exports/transactions", requestCount: 4 },
      { endpoint: "POST /api/loans", requestCount: 6 },
    ]);

    const res = await request(app)
      .get("/api/keys/usage/report?since=2026-01-01T00:00:00.000Z&until=2026-01-31T00:00:00.000Z")
      .set("Authorization", "Bearer rm_key_a");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      apiKeyId: "key-a",
      totalRequests: 10,
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-01-31T00:00:00.000Z",
    });
    expect(res.body.byEndpoint).toEqual([
      { endpoint: "POST /api/loans", requestCount: 6 },
      { endpoint: "GET /api/exports/transactions", requestCount: 4 },
    ]);
  });

  it("never returns another key's usage", async () => {
    mockApiKeyFindUnique.mockResolvedValue(keyB);
    mockUsageFindMany.mockResolvedValue([{ requestCount: 1 }]);
    mockEndpointFindMany.mockResolvedValue([
      { endpoint: "GET /api/keys/usage", requestCount: 1 },
    ]);

    const res = await request(app)
      .get("/api/keys/usage/report")
      .set("Authorization", "Bearer rm_key_b");

    expect(res.status).toBe(200);
    expect(res.body.apiKeyId).toBe("key-b");
    expect(res.body.totalRequests).toBe(1);
    // Every query is scoped to the authenticated key; key-a is never touched.
    expect(mockUsageFindMany.mock.calls.every((c) => c[0].where.apiKeyId === "key-b")).toBe(true);
    expect(mockEndpointFindMany.mock.calls.every((c) => c[0].where.apiKeyId === "key-b")).toBe(true);
  });

  it.each([
    "since=not-a-date",
    "until=not-a-date",
    "since=2026-05-01T00:00:00.000Z&until=2026-01-01T00:00:00.000Z",
  ])("rejects an invalid period %s", async (query) => {
    mockApiKeyFindUnique.mockResolvedValue(keyA);
    const res = await request(app)
      .get(`/api/keys/usage/report?${query}`)
      .set("Authorization", "Bearer rm_key_a");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_period" });
  });
});
