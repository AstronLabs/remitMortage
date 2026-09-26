// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Request, Response, NextFunction } from "express";
import { trace } from "@opentelemetry/api";
import { normaliseRoute } from "./metricsMiddleware.js";

/**
 * Connects the OpenTelemetry span auto-instrumentation creates for each
 * request to Express's own routing: annotates the span with the matched
 * route pattern (not the raw, high-cardinality URL) and status code, and
 * echoes the trace id back on the response so it can be correlated with
 * logs/metrics for the same request.
 *
 * A no-op when tracing is disabled (OTEL_EXPORTER_OTLP_ENDPOINT unset) —
 * `trace.getActiveSpan()` simply returns undefined in that case.
 */
export function tracingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const span = trace.getActiveSpan();

  if (span) {
    res.setHeader("x-trace-id", span.spanContext().traceId);

    res.on("finish", () => {
      const route =
        (req.route?.path as string | undefined) ??
        normaliseRoute(req.originalUrl ?? req.url ?? "/");

      span.setAttribute("http.route", route);
      span.setAttribute("http.status_code", res.statusCode);
    });
  }

  next();
}
