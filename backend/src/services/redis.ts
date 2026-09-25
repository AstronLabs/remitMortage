// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import Redis from "ioredis";
import logger from "../utils/logger.js";

let redisClient: Redis | null = null;

/**
 * Initialize and connect to Redis.
 * If REDIS_URL is not set, returns null (graceful degradation).
 * Configures connection pooling suitable for both cache and event-queue usage.
 */
export async function initializeRedis(): Promise<Redis | null> {
  const redisUrl =
    process.env.REDIS_EVENT_QUEUE_URL || process.env.REDIS_URL;

  if (!redisUrl) {
    logger.warn("REDIS_URL not configured; caching and event queue will be disabled");
    return null;
  }

  try {
    const poolSize = parseInt(process.env.REDIS_POOL_SIZE || "10", 10);
    const options = {
      lazyConnect: true,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      enableOfflineQueue: true,
      // Connection pool sizing
      connectionName: `remitmortage-${process.env.NODE_ENV || "development"}`,
      keepAlive: 30000,
      family: 4,
    };

    redisClient = new Redis(redisUrl, options);

    redisClient.on("connect", () => {
      logger.info("Redis connected successfully");
    });

    redisClient.on("error", (err) => {
      logger.error("Redis connection error", { error: err });
    });

    // Test the connection
    await redisClient.ping();
    logger.info("Redis ping successful");

    return redisClient;
  } catch (error) {
    logger.error("Failed to initialize Redis", { error });
    redisClient = null;
    return null;
  }
}

/**
 * Get the Redis client instance.
 * Returns null if Redis is not available.
 */
export function getRedisClient(): Redis | null {
  return redisClient;
}

/**
 * Close the Redis connection.
 */
export async function closeRedis(): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.quit();
      logger.info("Redis connection closed");
    } catch (error) {
      logger.error("Error closing Redis connection", { error });
    }
  }
}

/**
 * Cache helper: get a value from Redis.
 */
export async function getCacheValue<T>(key: string): Promise<T | null> {
  const client = getRedisClient();
  if (!client) return null;

  try {
    const cached = await client.get(key);
    if (!cached) return null;
    return JSON.parse(cached) as T;
  } catch (error) {
    logger.warn("Redis cache get error", { key, error });
    return null;
  }
}

/**
 * Cache helper: set a value in Redis with TTL (in seconds).
 */
export async function setCacheValue<T>(
  key: string,
  value: T,
  ttlSeconds: number = 300
): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  try {
    await client.setex(key, ttlSeconds, JSON.stringify(value));
  } catch (error) {
    logger.warn("Redis cache set error", { key, error });
  }
}

/**
 * Cache helper: delete a value from Redis.
 */
export async function deleteCacheValue(key: string): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  try {
    await client.del(key);
  } catch (error) {
    logger.warn("Redis cache delete error", { key, error });
  }
}

/**
 * Cache helper: delete multiple values from Redis by pattern.
 */
export async function deleteCacheByPattern(pattern: string): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  try {
    const keys = await client.keys(pattern);
    if (keys.length > 0) {
      await client.del(...keys);
    }
  } catch (error) {
    logger.warn("Redis cache delete by pattern error", { pattern, error });
  }
}
