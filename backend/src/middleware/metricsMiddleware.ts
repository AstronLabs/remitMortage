// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Request, Response, NextFunction } from "express";
import {
  httpRequestsTotal,
  httpRequestDurationSeconds,
  httpRequestsByVersionTotal,
  httpRequestBodySizeBytes,
  httpResponseBodySizeBytes,
} from "../services/metrics.js";
import { CURRENT_API_VERSION } from "./apiVersioning.js";
import { getCorrelationId } from "./correlationId.js";
import { ROUTE_LATENCY_BUDGETS, resolveLatencyBudget, type RouteLatencyBudgetConfig } from "../config/routeLatencyBudgets.js";
import { recordLatencySample } from "../services/latencyBudgetMonitor.js";

// ---------------------------------------------------------------------------
// Route normalisation
// ---------------------------------------------------------------------------

/**
 * Collapse dynamic path segments into generic placeholders so high-cardinality
 * label values don't bloat the Prometheus TSDB.
 *
 * Examples:
 *   /api/loan/abc123          → /api/loan/:id
 *   /api/borrower/G1234.../tx → /api/borrower/:address/tx
 *   /api/analytics            → /api/analytics
 */
export function normaliseRoute(url: string): string {
  return (
    url
      // Strip query strings.
      .split("?")[0]
      // Stellar G-addresses (56 chars starting with G).
      .replace(/\/G[A-Z0-9]{55}/g, "/:address")
      // Hex / base58 IDs that look like hashes (32+ hex chars).
      .replace(/\/[0-9a-f]{32,}/gi, "/:hash")
      // Plain numeric IDs.
      .replace(/\/\d+/g, "/:id")
      // UUIDs.
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:uuid")
      // Alphanumeric slugs that are clearly IDs (e.g. Mongo ObjectIds).
      .replace(/\/[a-z0-9]{20,}/gi, "/:id")
      || "/"
  );
}

// ---------------------------------------------------------------------------
// HTTP instrumentation middleware
// ---------------------------------------------------------------------------

/**
 * Full, bounded route template for a request: the mounted router path plus
 * the matched route path (`/api/loan` + `/:id` → `/api/loan/:id`). Falls back
 * to the normalised raw URL when routing did not resolve (e.g. 404s).
 */
export function resolveRouteLabel(req: Request): string {
  const matched = req.route?.path as unknown;
  if (typeof matched === "string") {
    const base = req.baseUrl ?? "";
    if (matched === "/") return base || "/";
    return `${base}${matched}`;
  }
  return normaliseRoute(req.originalUrl ?? req.url ?? "/");
}

function byteLength(chunk: unknown): number {
  if (typeof chunk === "string") return Buffer.byteLength(chunk);
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
}

/**
 * Counts the bytes actually written to the response, including body chunks
 * passed to `res.end`. Returns a reader for the running total.
 */
function countResponseBytes(res: Response): () => number {
  let bytes = 0;
  const write = res.write.bind(res) as (...args: unknown[]) => boolean;
  const end = res.end.bind(res) as (...args: unknown[]) => Response;

  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    bytes += byteLength(chunk);
    return write(chunk, ...rest);
  }) as Response["write"];

  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    bytes += byteLength(chunk);
    return end(chunk, ...rest);
  }) as Response["end"];

  return () => bytes;
}

export interface HttpMetricsOptions {
  /** Latency budgets to compare against; defaults to the shared config. */
  latencyBudgets?: RouteLatencyBudgetConfig;
}

/**
 * Builds the HTTP instrumentation middleware. The default export compares
 * against `config/routeLatencyBudgets.ts`; tests pass a tighter config to
 * exercise the warning path without slow handlers.
 *
 * Records per-request:
 *   - `remitmortgage_http_requests_total`             (counter)
 *   - `remitmortgage_http_request_duration_seconds`   (histogram)
 *   - `remitmortgage_http_request_body_size_bytes`    (histogram)
 *   - `remitmortgage_http_response_body_size_bytes`   (histogram)
 *   - `remitmortgage_route_latency_budget_exceeded_total` (counter)
 *
 * Must be mounted **before** all route handlers so the timer starts from the
 * moment the request enters Express. The route label is resolved after
 * routing completes, so it is the route template rather than the raw URL.
 */
export function createHttpMetricsMiddleware(
  options: HttpMetricsOptions = {}
): (req: Request, res: Response, next: NextFunction) => void {
  const budgets = options.latencyBudgets ?? ROUTE_LATENCY_BUDGETS;

  return (req, res, next) => {
    const startHr = process.hrtime.bigint();
    const method = req.method.toUpperCase();
    const declaredLength = Number(req.headers["content-length"]);
    const requestBytes =
      Number.isFinite(declaredLength) && declaredLength >= 0 ? declaredLength : 0;
    const responseBytes = countResponseBytes(res);

    // API versioning (issue #847): echo back whichever version was served so
    // a client can confirm it, defaulting to CURRENT_API_VERSION since no
    // client sends the request header yet — every endpoint today is that
    // version. Set eagerly (not in the `finish` handler) so it's present even
    // if a later middleware/handler ends the response early.
    const requestedVersion =
      (req.headers["api-version"] as string | undefined)?.trim() || CURRENT_API_VERSION;
    res.setHeader("Api-Version", requestedVersion);

    res.on("finish", () => {
      const durationS = Number(process.hrtime.bigint() - startHr) / 1e9;
      const durationMs = durationS * 1000;
      const route = resolveRouteLabel(req);
      const statusCode = String(res.statusCode);

      httpRequestsTotal.inc({ method, route, status_code: statusCode });
      httpRequestDurationSeconds.observe(
        { method, route, status_code: statusCode },
        durationS
      );
      httpRequestsByVersionTotal.inc({ version: requestedVersion, method, route });
      httpRequestBodySizeBytes.observe({ method, route }, requestBytes);
      httpResponseBodySizeBytes.observe({ method, route }, responseBytes());

      recordLatencySample({
        method,
        route,
        durationMs,
        budgetMs: resolveLatencyBudget(method, route, budgets),
        requestId: getCorrelationId(),
      });
    });

    next();
  };
}

/** Shared middleware instance using the configured route budgets. */
export const httpMetricsMiddleware = createHttpMetricsMiddleware();

// ---------------------------------------------------------------------------
// Metrics endpoint auth middleware
// ---------------------------------------------------------------------------

/**
 * Protects the `/metrics` endpoint with a static bearer token sourced from
 * `METRICS_TOKEN` env var.
 *
 * When `METRICS_TOKEN` is not set the endpoint is open — suitable for local
 * development but should always be set in production.
 *
 * Prometheus scrapers should be configured to include:
 *   Authorization: Bearer <METRICS_TOKEN>
 */
export function metricsAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const token = process.env.METRICS_TOKEN;

  // No token configured → open access (dev only).
  if (!token) {
    next();
    return;
  }

  const authHeader = req.headers.authorization ?? "";
  const provided = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (!provided || provided !== token) {
    res
      .status(401)
      .set("WWW-Authenticate", 'Bearer realm="metrics"')
      .json({ error: "unauthorized", message: "Valid METRICS_TOKEN required" });
    return;
  }

  next();
}
