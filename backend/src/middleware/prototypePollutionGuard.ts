// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Edge guard against prototype-pollution payloads (issue #885).
 *
 * Runs immediately after body parsing and strips `__proto__`, `constructor`
 * and `prototype` keys from `req.body` and `req.query`, so no handler,
 * validator or merge helper ever sees them. A stripped request is still
 * served — the payload is simply missing keys that are never legitimate
 * input — which keeps a probe indistinguishable from a client that sent
 * nothing unusual.
 *
 * `mode: "reject"` turns it into a 400 instead, for routes where receiving
 * such a key at all is evidence of an attack rather than a sloppy client.
 *
 * `req.params` is not swept: its keys come from the route pattern (`/:address`),
 * never from the caller, so a request cannot introduce a key there.
 *
 * Stripping is only the first of three layers; see `utils/safeObject.ts`.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { sanitizeDeep } from "../utils/safeObject.js";
import { prototypePollutionStrippedTotal } from "../services/metrics.js";
import { logAudit } from "../services/audit.js";
import logger from "../utils/logger.js";

export type PollutionGuardMode = "strip" | "reject";

export interface PollutionGuardOptions {
  /** `strip` (default) silently removes the keys; `reject` answers 400. */
  mode?: PollutionGuardMode;
}

export function prototypePollutionGuard(
  options: PollutionGuardOptions = {}
): RequestHandler {
  const mode = options.mode ?? "strip";

  return function guard(req: Request, res: Response, next: NextFunction): void {
    const findings: string[] = [];

    const body = req.body as unknown;
    if (body !== null && typeof body === "object") {
      for (const path of sanitizeDeep(body).stripped) findings.push(`body.${path}`);
    }

    // `req.query` is a non-caching getter in Express 5 — it re-parses the query
    // string on every read, so sanitising the object it returns would be thrown
    // away. Pin the sanitised copy as an own property instead, shadowing the
    // getter for the rest of the request.
    const query = req.query as unknown;
    if (query !== null && typeof query === "object") {
      const { value, stripped } = sanitizeDeep(query);
      if (stripped.length > 0) {
        for (const path of stripped) findings.push(`query.${path}`);
      }
      Object.defineProperty(req, "query", {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }

    if (findings.length === 0) {
      next();
      return;
    }

    const route = req.baseUrl || req.path || "unknown";
    prototypePollutionStrippedTotal.inc({ mode, route }, findings.length);

    logger.warn("[prototype-pollution] stripped reserved keys from request", {
      mode,
      method: req.method,
      path: req.originalUrl || req.url,
      ip: req.ip,
      keys: findings,
    });

    // A pollution payload is a deliberate probe, so it belongs in the audit
    // trail next to every other security-relevant event. Fire and forget —
    // logAudit already swallows its own failures.
    void logAudit({
      action: "security.prototype_pollution.blocked",
      ipAddress: req.ip,
      metadata: {
        mode,
        method: req.method,
        path: req.originalUrl || req.url,
        keys: findings,
      },
    });

    if (mode === "reject") {
      res.status(400).json({
        error: "unsafe_payload",
        message: "Request contained reserved object keys and was rejected.",
        statusCode: 400,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    next();
  };
}
