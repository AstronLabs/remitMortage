// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";
import {
  CORRELATION_ID_HEADER,
  correlationId,
  correlationHeaders,
  getCorrelationId,
  normalizeCorrelationId,
} from "../middleware/correlationId.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("Correlation ID middleware", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(correlationId);
    app.get("/trace", (_req, res) => {
      res.status(200).json({
        insideRequest: getCorrelationId(),
        outgoing: correlationHeaders(),
      });
    });
  });

  it("mints a UUID and echoes it on the response", async () => {
    const res = await request(app).get("/trace");

    expect(res.status).toBe(200);
    const echoed = res.headers[CORRELATION_ID_HEADER.toLowerCase()];
    expect(echoed).toMatch(UUID_PATTERN);
    expect(res.body.insideRequest).toBe(echoed);
  });

  it("gives each request a distinct ID", async () => {
    const first = await request(app).get("/trace");
    const second = await request(app).get("/trace");

    expect(first.body.insideRequest).not.toBe(second.body.insideRequest);
  });

  it("adopts a well-formed inbound correlation ID", async () => {
    const inbound = "trace-abc.123:xyz";
    const res = await request(app)
      .get("/trace")
      .set(CORRELATION_ID_HEADER, inbound);

    expect(res.body.insideRequest).toBe(inbound);
    expect(res.headers[CORRELATION_ID_HEADER.toLowerCase()]).toBe(inbound);
  });

  it("exposes the ID as headers for outgoing calls", async () => {
    const res = await request(app).get("/trace");

    expect(res.body.outgoing).toEqual({
      [CORRELATION_ID_HEADER]: res.body.insideRequest,
    });
  });

  it("returns no correlation headers outside a request context", () => {
    expect(getCorrelationId()).toBeUndefined();
    expect(correlationHeaders()).toEqual({});
  });
});

describe("normalizeCorrelationId", () => {
  it("keeps safe inbound IDs verbatim", () => {
    expect(normalizeCorrelationId("abc-123_DEF.456:x")).toBe("abc-123_DEF.456:x");
  });

  it("replaces IDs containing log-injection characters", () => {
    expect(normalizeCorrelationId("bad\nid")).toMatch(UUID_PATTERN);
    expect(normalizeCorrelationId("bad id")).toMatch(UUID_PATTERN);
  });

  it("replaces oversized, empty and non-string IDs", () => {
    expect(normalizeCorrelationId("a".repeat(129))).toMatch(UUID_PATTERN);
    expect(normalizeCorrelationId("")).toMatch(UUID_PATTERN);
    expect(normalizeCorrelationId(undefined)).toMatch(UUID_PATTERN);
    expect(normalizeCorrelationId(["a", "b"])).toMatch(UUID_PATTERN);
  });
});
