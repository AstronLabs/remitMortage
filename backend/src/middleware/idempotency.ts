// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import type { Request, Response, NextFunction } from "express";
import { getRedisClient } from "../services/redis.js";
import logger from "../utils/logger.js";

const IDEMPOTENCY_TTL_SECONDS = parseInt(
  process.env.IDEMPOTENCY_TTL_SECONDS || "86400", // 24 hours default
  10
);

/**
 * Idempotency middleware for payment-submission endpoints.
 *
 * Accepts an `Idempotency-Key` header. On the first request the handler
 * executes normally and the response is cached keyed by the idempotency
 * key. Repeat requests within the TTL window return the cached response
 * without re-executing the handler.
 *
 * If Redis is unavailable, the middleware is a no-op (requests pass through)
 * so that transient cache outages never block payments.
 */
export function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const key = req.headers["idempotency-key"] as string | undefined;

  // If no key is provided, skip idempotency and let the handler execute.
  if (!key) {
    return next();
  }

  const redis = getRedisClient();
  if (!redis) {
    // Redis unavailable — degrade gracefully, execute handler.
    return next();
  }

  const cacheKey = `idempotency:${key}`;

  redis
    .get(cacheKey)
    .then((cached) => {
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          res.status(parsed.statusCode || 200).json(parsed.body);
        } catch {
          // Corrupted cache entry — ignore and re-execute.
          interceptAndCache(req, res, next, redis, cacheKey);
        }
        return;
      }

      interceptAndCache(req, res, next, redis, cacheKey);
    })
    .catch((err) => {
      logger.warn("Idempotency cache read error, executing handler", { error: err });
      next();
    });
}

/**
 * Intercepts res.json() to capture the response body, then stores it
 * in Redis under the idempotency key.
 */
function interceptAndCache(
  req: Request,
  res: Response,
  next: NextFunction,
  redis: ReturnType<typeof getRedisClient>,
  cacheKey: string
): void {
  const originalJson = res.json.bind(res);

  res.json = function (body: unknown) {
    // Only cache successful responses (2xx).
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const payload = JSON.stringify({
        statusCode: res.statusCode,
        body,
      });

      redis!
        .setex(cacheKey, IDEMPOTENCY_TTL_SECONDS, payload)
        .catch((err) => {
          logger.warn("Idempotency cache write error", { error: err });
        });
    }

    return originalJson(body);
  };

  next();
}
