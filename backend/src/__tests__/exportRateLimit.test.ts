// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express, { Request, Response, NextFunction } from "express";
import request from "supertest";
import {
  ExportQuotaTracker,
  exportRateLimiter,
  loadExportQuotaConfig,
  parseScopeQuotas,
  recordExportedRows,
} from "../middleware/exportRateLimit";

const WINDOW_MS = 60 * 60 * 1000;

function buildApp(rowsPerRequest: number, maxRows: number, now: () => number) {
  const config = { windowMs: WINDOW_MS, defaultMaxRows: maxRows, maxRowsByScope: {} };
  const tracker = new ExportQuotaTracker(WINDOW_MS, now);
  const app = express();
  app.get(
    "/export",
    (req: Request, res: Response, next: NextFunction) => {
      res.locals.apiKey = { id: String(req.headers["x-key-id"] ?? "key-1") };
      next();
    },
    exportRateLimiter("export:transactions", config, tracker),
    (_req, res) => {
      recordExportedRows(res, rowsPerRequest);
      res.json({ count: rowsPerRequest });
    },
  );
  return app;
}

describe("parseScopeQuotas / loadExportQuotaConfig", () => {
  it("parses scope=rows pairs and ignores malformed entries", () => {
    expect(parseScopeQuotas("export:transactions=50000, export:analytics=100,bad,x=-5,=3")).toEqual({
      "export:transactions": 50000,
      "export:analytics": 100,
    });
    expect(parseScopeQuotas(undefined)).toEqual({});
  });

  it("falls back to defaults when env values are missing or invalid", () => {
    expect(loadExportQuotaConfig({})).toEqual({
      windowMs: 3_600_000,
      defaultMaxRows: 50_000,
      maxRowsByScope: {},
    });
    expect(
      loadExportQuotaConfig({
        EXPORT_QUOTA_WINDOW_MS: "1000",
        EXPORT_QUOTA_DEFAULT_ROWS: "10",
        EXPORT_QUOTA_BY_SCOPE: "export:analytics=5",
      }),
    ).toEqual({ windowMs: 1000, defaultMaxRows: 10, maxRowsByScope: { "export:analytics": 5 } });
  });
});

describe("ExportQuotaTracker", () => {
  it("sums rows within the window and forgets rows once they age out", () => {
    let now = 0;
    const tracker = new ExportQuotaTracker(1000, () => now);
    tracker.record("k", 3);
    now = 500;
    tracker.record("k", 4);
    tracker.record("k", 0);
    expect(tracker.used("k")).toBe(7);
    now = 1001;
    expect(tracker.used("k")).toBe(4);
    now = 1501;
    expect(tracker.used("k")).toBe(0);
  });

  it("computes retry-after from when enough old usage expires", () => {
    let now = 0;
    const tracker = new ExportQuotaTracker(10_000, () => now);
    tracker.record("k", 6);
    now = 4000;
    tracker.record("k", 6);
    expect(tracker.retryAfterSeconds("k", 20)).toBe(0);
    // 12 used, quota 10: dropping the first entry (expires at t=10s) is enough.
    expect(tracker.retryAfterSeconds("k", 10)).toBe(6);
    // quota 5: both entries must expire; the second expires at t=14s.
    expect(tracker.retryAfterSeconds("k", 5)).toBe(10);
  });
});

describe("exportRateLimiter", () => {
  it("rejects an API key over its export volume with 429 and an accurate Retry-After", async () => {
    let now = 1_000_000;
    const app = buildApp(400, 1000, () => now);

    for (let i = 0; i < 3; i++) {
      const res = await request(app).get("/export");
      expect(res.status).toBe(200);
      now += 60_000;
    }

    const blocked = await request(app).get("/export");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: "export_quota_exceeded", statusCode: 429 });
    // 1200 rows used against a 1000 quota: the first 400-row export (at t0)
    // must expire, which happens WINDOW_MS after t0 = 3 minutes before "now".
    const expected = (WINDOW_MS - 3 * 60_000) / 1000;
    expect(blocked.headers["retry-after"]).toBe(String(expected));
    expect(blocked.body.retryAfter).toBe(expected);
    expect(blocked.headers["x-export-quota-remaining"]).toBe("0");
  });

  it("tracks quotas per API key independently", async () => {
    const now = 0;
    const app = buildApp(1000, 1000, () => now);
    expect((await request(app).get("/export").set("x-key-id", "a")).status).toBe(200);
    expect((await request(app).get("/export").set("x-key-id", "a")).status).toBe(429);
    expect((await request(app).get("/export").set("x-key-id", "b")).status).toBe(200);
  });

  it("resets once the rolling window elapses without a restart", async () => {
    let now = 0;
    const app = buildApp(1000, 1000, () => now);
    expect((await request(app).get("/export")).status).toBe(200);
    expect((await request(app).get("/export")).status).toBe(429);

    now = WINDOW_MS - 1;
    expect((await request(app).get("/export")).status).toBe(429);

    now = WINDOW_MS + 1;
    const res = await request(app).get("/export");
    expect(res.status).toBe(200);
    expect(res.headers["x-export-quota-remaining"]).toBe("1000");
  });

  it("applies the per-scope quota override instead of the default", async () => {
    const app = express();
    const config = {
      windowMs: WINDOW_MS,
      defaultMaxRows: 1_000_000,
      maxRowsByScope: { "export:analytics": 10 },
    };
    app.get(
      "/export",
      (_req, res, next) => {
        res.locals.apiKey = { id: "key-1" };
        next();
      },
      exportRateLimiter("export:analytics", config),
      (_req, res) => {
        recordExportedRows(res, 10);
        res.json({});
      },
    );
    const first = await request(app).get("/export");
    expect(first.headers["x-export-quota-limit"]).toBe("10");
    expect((await request(app).get("/export")).status).toBe(429);
  });
});
