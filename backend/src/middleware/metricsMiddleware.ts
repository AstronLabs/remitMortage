// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Request, Response, NextFunction } from "express";
import {
  httpRequestsTotal,
  httpRequestDurationSeconds,
} from "../services/metrics.js";

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
 * Records per-request HTTP metrics:
 *   - `remitmortgage_http_requests_total`   (counter)
 *   - `remitmortgage_http_request_duration_seconds` (histogram)
 *
 * Must be mounted **before** all route handlers so the timer starts from the
 * moment the request enters Express.
 *
 * Note: the route label is resolved from `req.route.path` *after* routing
 * completes (in the `finish` event) so matched Express routes are used where
 * possible, falling back to the normalised raw URL for unmatched paths.
 */
export function httpMetricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const startHr = process.hrtime.bigint();
  const method = req.method.toUpperCase();

  res.on("finish", () => {
    const durationS =
      Number(process.hrtime.bigint() - startHr) / 1e9;

    // Prefer the matched Express route pattern (e.g. /api/loan/:id) over the
    // raw URL to keep cardinality low.  Fall back to the normalised URL when
    // routing hasn't resolved (e.g. 404s).
    const route =
      (req.route?.path as string | undefined) ??
      normaliseRoute(req.originalUrl ?? req.url ?? "/");

    const statusCode = String(res.statusCode);

    httpRequestsTotal.inc({ method, route, status_code: statusCode });
    httpRequestDurationSeconds.observe(
      { method, route, status_code: statusCode },
      durationS
    );
  });

  next();
}

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
