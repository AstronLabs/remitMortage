// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Request, Response } from "express";

/**
 * Terminal handler for requests that matched no route.
 *
 * The IP allowlist (`middleware/adminIpAllowlist.ts`) deliberately answers a
 * blocked admin request through this same handler, so the two responses are
 * byte-for-byte identical. That is what stops the allowlist from turning into
 * an endpoint oracle: an off-network caller probing `/api/admin/...` cannot tell
 * a blocked-but-real route from a path that never existed. Any per-request
 * context (e.g. a request id) must therefore stay free of route information.
 *
 * Registered last, after every router and before `errorHandler`.
 */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({
    error: "not_found",
    message: "Resource not found",
    statusCode: 404,
    timestamp: new Date().toISOString(),
  });
}
