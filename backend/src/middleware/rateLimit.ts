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
