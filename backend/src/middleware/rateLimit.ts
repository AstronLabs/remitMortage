// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import rateLimit from "express-rate-limit";

/**
 * Strict rate limiter for wallet-verification endpoints: 10 requests per
 * minute per IP.
 *
 * These endpoints trigger cryptographic operations and on-chain lookups, so
 * they require tighter protection than general verification queries.
 */
function createVerificationRateLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      const retryAfter = Math.ceil(60);
      res.status(429).json({
        error: "Too many requests",
        retryAfter,
        statusCode: 429,
      });
    },
  });
}

export const verificationChallengeRateLimiter = createVerificationRateLimiter();
export const verificationOwnershipRateLimiter = createVerificationRateLimiter();

/** Shared 429 handler so every limiter returns a consistent error shape. */
function tooManyRequestsHandler(windowMs: number) {
  const retryAfter = Math.ceil(windowMs / 1000);
  return (_req: unknown, res: {
    status: (code: number) => { json: (body: unknown) => void };
  }) => {
    res.status(429).json({
      error: "Too many requests",
      retryAfter,
      statusCode: 429,
      timestamp: new Date().toISOString(),
    });
  };
}

/**
 * Baseline limiter applied to every API request: 300 requests per minute per
 * IP. Generous enough for normal browsing and polling, but caps naive
 * denial-of-service floods.
 */
export const globalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooManyRequestsHandler(60 * 1000),
});

/**
 * Tighter limiter for sensitive, abuse-prone endpoints (authentication,
 * identity, admin): 20 requests per minute per IP.
 */
export const sensitiveRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooManyRequestsHandler(60 * 1000),
});

/**
 * Moderate limiter for state-mutating resource endpoints (loans, borrowers,
 * milestones): 60 requests per minute per IP.
 */
export const mutationRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooManyRequestsHandler(60 * 1000),
});
