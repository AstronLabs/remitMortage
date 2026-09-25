// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/** Rate limiting for demo / sandbox mode.
 *  Prevents abuse of demo endpoints by capping requests per IP.
 *  Only active when DEMO_MODE=true. */

import rateLimit from "express-rate-limit";

export function demoRateLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Demo rate limit exceeded. Try again in a minute." },
    skip: () => process.env.DEMO_MODE !== "true",
  });
}
