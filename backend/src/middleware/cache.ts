// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Request, Response, NextFunction } from "express";
import { getCacheValue, setCacheValue } from "../services/redis.js";
import logger from "../utils/logger.js";

/**
 * Middleware to cache API JSON responses in Redis.
 * Keys are derived predictably from the request originalUrl.
 * @param ttlSeconds - Time-to-live for the cached response
 */
export function cacheMiddleware(ttlSeconds: number = 60) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.method !== "GET") {
      next();
      return;
    }

    const key = `analytics:${req.originalUrl || req.url}`;

    try {
      const cachedResponse = await getCacheValue<any>(key);
      if (cachedResponse) {
        logger.info(`[CacheMiddleware] HIT ${key}`);
        res.json(cachedResponse);
        return;
      }
    } catch (err) {
      logger.warn(`[CacheMiddleware] Error reading cache for key: ${key}`, { err });
      // Proceed without cache on error
    }

    // Override res.json to cache the output before sending
    const originalJson = res.json.bind(res);
    res.json = (body: any): Response => {
      // Only cache successful responses (e.g. 200 OK)
      if (res.statusCode >= 200 && res.statusCode < 300) {
        setCacheValue(key, body, ttlSeconds).catch((err) => {
          logger.warn(`[CacheMiddleware] Error setting cache for key: ${key}`, { err });
        });
      }
      return originalJson(body);
    };

    next();
  };
}
