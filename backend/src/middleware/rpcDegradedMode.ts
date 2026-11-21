// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Graceful-degradation HTTP behaviour while Soroban RPC is unavailable
 * (issue #984).
 *
 * - Reads (`GET`/`HEAD`/`OPTIONS`) continue to be served from PostgreSQL or
 *   cache, but carry headers marking the payload as possibly stale.
 * - Chain-dependent writes opt into `requireRpcAvailable()` and fail fast with
 *   a clear, retryable `503` instead of a generic timeout/500.
 */

import type { Request, Response, NextFunction } from "express";
import { isRpcDegraded } from "../services/rpcDegradedState.js";

export const STALE_DATA_HEADER = "X-Data-Stale";
export const RPC_DEGRADED_HEADER = "X-RPC-Degraded";
export const STALE_WARNING = '110 - "Response may be stale: Soroban RPC is unavailable"';
export const RPC_RETRY_AFTER_SECONDS = 5;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface RpcDegradedModeOptions {
  /** Override the degraded-state source (defaults to the process-wide flag). */
  isDegraded?: () => boolean;
}

/**
 * Marks read responses as possibly stale while the RPC is down. Writes are
 * left alone here because most do not need the chain; only routes guarded by
 * {@link requireRpcAvailable} are rejected.
 */
export function rpcDegradedMode(options: RpcDegradedModeOptions = {}) {
  const state = options.isDegraded ?? isRpcDegraded;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!state() || !SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    res.setHeader(STALE_DATA_HEADER, "true");
    res.setHeader(RPC_DEGRADED_HEADER, "true");
    res.setHeader("Warning", STALE_WARNING);
    next();
  };
}

/**
 * Guard for writes that build or depend on a Soroban transaction. Fails fast
 * with `503` + `Retry-After` while every configured RPC node is unhealthy.
 */
export function requireRpcAvailable(options: RpcDegradedModeOptions = {}) {
  const state = options.isDegraded ?? isRpcDegraded;

  return (_req: Request, res: Response, next: NextFunction): void => {
    if (!state()) {
      next();
      return;
    }

    res.setHeader("Retry-After", String(RPC_RETRY_AFTER_SECONDS));
    res.setHeader(RPC_DEGRADED_HEADER, "true");
    res.status(503).json({
      error: "rpc_unavailable",
      code: "rpc_unavailable",
      message:
        "Soroban RPC is currently unavailable. This operation needs the chain; please retry shortly.",
      retryable: true,
      retryAfterSeconds: RPC_RETRY_AFTER_SECONDS,
      statusCode: 503,
      timestamp: new Date().toISOString(),
    });
  };
}
