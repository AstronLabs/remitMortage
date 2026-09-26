// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { EventEmitter } from "events";
import { tracingMiddleware } from "../middleware/tracingMiddleware.js";
import { trace } from "@opentelemetry/api";

function fakeSpan() {
  return {
    spanContext: () => ({ traceId: "trace-abc-123" }),
    setAttribute: jest.fn(),
  };
}

function fakeReqRes(overrides: Partial<{ route: { path: string }; originalUrl: string }> = {}) {
  const req: any = { originalUrl: overrides.originalUrl ?? "/api/loan/abc123", route: overrides.route };
  const res: any = Object.assign(new EventEmitter(), {
    setHeader: jest.fn(),
    statusCode: 200,
  });
  return { req, res };
}

describe("tracingMiddleware", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("is a no-op when there is no active span (tracing disabled)", () => {
    jest.spyOn(trace, "getActiveSpan").mockReturnValue(undefined);
    const { req, res } = fakeReqRes();
    const next = jest.fn();

    tracingMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it("echoes the trace id and annotates the span with the matched Express route on finish", () => {
    const span = fakeSpan();
    jest.spyOn(trace, "getActiveSpan").mockReturnValue(span as any);
    const { req, res } = fakeReqRes({ route: { path: "/api/loan/:id" } });
    const next = jest.fn();

    tracingMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith("x-trace-id", "trace-abc-123");

    res.statusCode = 200;
    res.emit("finish");

    expect(span.setAttribute).toHaveBeenCalledWith("http.route", "/api/loan/:id");
    expect(span.setAttribute).toHaveBeenCalledWith("http.status_code", 200);
  });

  it("falls back to a normalised URL when Express hasn't matched a route (e.g. a 404)", () => {
    const span = fakeSpan();
    jest.spyOn(trace, "getActiveSpan").mockReturnValue(span as any);
    const { req, res } = fakeReqRes({ originalUrl: "/api/loan/123456" });
    const next = jest.fn();

    tracingMiddleware(req, res, next);
    res.statusCode = 404;
    res.emit("finish");

    expect(span.setAttribute).toHaveBeenCalledWith("http.route", "/api/loan/:id");
    expect(span.setAttribute).toHaveBeenCalledWith("http.status_code", 404);
  });
});
