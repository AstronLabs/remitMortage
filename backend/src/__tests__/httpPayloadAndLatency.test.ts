// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Request/response size histograms (issue #987) and per-route latency budgets
 * (issue #988). Both are driven through real Express requests with supertest,
 * including an artificially delayed handler, and read back from the registry.
 */

import express from "express";
import request from "supertest";

jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../middleware/auth.js", () => ({
  requireAdmin: (req: express.Request, res: express.Response, next: express.NextFunction) =>
    req.headers.authorization === "Bearer test-admin-key"
      ? next()
      : res.status(401).json({ error: "missing_authorization" }),
}));

import logger from "../utils/logger.js";
import { createHttpMetricsMiddleware } from "../middleware/metricsMiddleware.js";
import { correlationId } from "../middleware/correlationId.js";
import {
  httpRequestBodySizeBytes,
  httpResponseBodySizeBytes,
  routeLatencyBudgetExceededTotal,
} from "../services/metrics.js";
import {
  _resetLatencyBudgetMonitor,
  getLatencyBudgetViolations,
} from "../services/latencyBudgetMonitor.js";

const FAST_BUDGETS = { defaultMs: 60_000, routes: {} };

function appWith(budgets: { defaultMs: number; routes: Record<string, number> } = FAST_BUDGETS) {
  const app = express();
  app.use(correlationId);
  app.use(createHttpMetricsMiddleware({ latencyBudgets: budgets }));
  app.use(express.json());
  app.get("/api/things/:id", (req, res) => {
    res.json({ id: req.params.id, note: "x".repeat(64) });
  });
  app.post("/api/things/:id", (req, res) => {
    res.status(201).json({ received: Boolean(req.body), id: req.params.id });
  });
  app.get("/api/fast", (_req, res) => res.json({ ok: true }));
  app.get("/api/slow", async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    res.json({ ok: true });
  });
  return app;
}

async function histogramValues(name: string) {
  const metric = (await (name === "request" ? httpRequestBodySizeBytes : httpResponseBodySizeBytes).get()) as any;
  return metric.values as Array<{ metricName: string; labels: Record<string, string>; value: number }>;
}

function sumFor(values: Array<{ metricName: string; labels: Record<string, string>; value: number }>, suffix: string, route: string) {
  return values
    .filter((v) => v.metricName.endsWith(suffix) && v.labels.route === route)
    .reduce((acc, v) => acc + v.value, 0);
}

async function exceededCounter(route: string): Promise<number> {
  const metric = await routeLatencyBudgetExceededTotal.get();
  const match = metric.values.find(
    (v: any) => v.labels.method === "GET" && v.labels.route === route
  );
  return match?.value ?? 0;
}

describe("request and response size histograms (issue #987)", () => {
  it("records both sizes against the route template", async () => {
    const app = appWith();
    const beforeReq = await histogramValues("request");
    const beforeRes = await histogramValues("response");

    await request(app).post("/api/things/abc123").send({ payload: "x".repeat(64) }).expect(201);

    const reqValues = await histogramValues("request");
    const resValues = await histogramValues("response");

    const requestCount = sumFor(reqValues, "_count", "/api/things/:id") - sumFor(beforeReq, "_count", "/api/things/:id");
    const responseCount = sumFor(resValues, "_count", "/api/things/:id") - sumFor(beforeRes, "_count", "/api/things/:id");

    expect(requestCount).toBe(1);
    expect(responseCount).toBe(1);
    expect(sumFor(reqValues, "_sum", "/api/things/:id")).toBeGreaterThan(0);
    expect(sumFor(resValues, "_sum", "/api/things/:id")).toBeGreaterThan(0);
  });

  it("does not create a label value per id", async () => {
    const app = appWith();
    await request(app).get("/api/things/first-id").expect(200);
    await request(app).get("/api/things/second-id").expect(200);

    const routes = new Set(
      (await histogramValues("response"))
        .filter((v) => v.labels.method === "GET" && v.labels.route.includes("/api/things/"))
        .map((v) => v.labels.route)
    );

    expect([...routes]).toEqual(["/api/things/:id"]);
  });
});

describe("per-route latency budgets (issue #988)", () => {
  beforeEach(() => {
    _resetLatencyBudgetMonitor();
  });

  it("warns with the route, duration and request id and counts the breach", async () => {
    const app = appWith({ defaultMs: 5, routes: { "GET /api/fast": 5_000 } });
    const before = await exceededCounter("/api/slow");

    await request(app).get("/api/slow").set("X-Correlation-Id", "corr-test-1").expect(200);

    expect(await exceededCounter("/api/slow")).toBe(before + 1);

    const warning = (logger.warn as jest.Mock).mock.calls.find(
      ([message, meta]) => message === "[latency-budget] request exceeded its route budget" && meta?.route === "/api/slow"
    );
    expect(warning?.[1]).toMatchObject({
      method: "GET",
      route: "/api/slow",
      budgetMs: 5,
      requestId: "corr-test-1",
    });
    expect(warning?.[1].durationMs).toBeGreaterThanOrEqual(5);
  });

  it("uses the default budget for routes without an explicit entry, and ranks the summary", async () => {
    const app = appWith({ defaultMs: 5, routes: { "GET /api/fast": 5_000 } });

    await request(app).get("/api/fast").expect(200);
    await request(app).get("/api/slow").expect(200);
    await request(app).get("/api/slow").expect(200);

    const violations = getLatencyBudgetViolations();

    expect(violations.find((v) => v.route === "/api/fast")).toBeUndefined();
    expect(violations[0]).toMatchObject({
      method: "GET",
      route: "/api/slow",
      budgetMs: 5,
      requests: 2,
      exceeded: 2,
      exceededRatio: 1,
    });
  });

  it("serves the ranked summary to admins only", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { adminLatencyRouter } = require("../routes/adminLatency.js");
    const app = express();
    app.use("/api/admin", adminLatencyRouter);

    const unauthorized = await request(app).get("/api/admin/latency-budget-violations");
    expect(unauthorized.status).toBe(401);

    const authorized = await request(app)
      .get("/api/admin/latency-budget-violations")
      .set("Authorization", "Bearer test-admin-key");

    expect(authorized.status).toBe(200);
    expect(authorized.body).toMatchObject({ defaultBudgetMs: expect.any(Number), routes: expect.any(Array) });
  });
});
