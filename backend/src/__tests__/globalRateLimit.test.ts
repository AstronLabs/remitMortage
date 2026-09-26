// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";
import { sensitiveRateLimiter } from "../middleware/rateLimit";

// Exercise a limiter with a small, deterministic threshold by reusing the
// sensitive limiter (20 req/min) which is the tightest general-purpose tier.
describe("sensitiveRateLimiter", () => {
  it("returns 429 once the per-window request cap is exceeded", async () => {
    const app = express();
    app.use(sensitiveRateLimiter);
    app.get("/ping", (_req, res) => res.json({ ok: true }));

    // The first 20 requests are allowed.
    for (let i = 0; i < 20; i++) {
      const res = await request(app).get("/ping");
      expect(res.status).not.toBe(429);
    }

    // The 21st is rate-limited with the shared error shape.
    const blocked = await request(app).get("/ping");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({
      error: "Too many requests",
      statusCode: 429,
    });
    expect(typeof blocked.body.retryAfter).toBe("number");
  });
});
