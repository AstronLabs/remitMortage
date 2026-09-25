// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { getRedisClient } from "./redis.js";
import { sendLockoutNotificationEmail } from "./email.js";
import logger from "../utils/logger.js";

const LOCKOUT_THRESHOLD = parseInt(process.env.LOCKOUT_THRESHOLD || "5", 10);
const BASE_LOCKOUT_SECONDS = parseInt(process.env.LOCKOUT_BASE_SECONDS || "30", 10);
const MAX_LOCKOUT_SECONDS = parseInt(process.env.LOCKOUT_MAX_SECONDS || "3600", 10);
const SLIDING_WINDOW_SECONDS = parseInt(process.env.LOCKOUT_SLIDING_WINDOW_SECONDS || "900", 10);

interface InMemLockoutRecord {
  failedAttempts: number;
  lockedUntilMs: number;
  lastFailedAtMs: number;
}

const inMemoryStore = new Map<string, InMemLockoutRecord>();

/**
 * Calculates exponential backoff duration in seconds based on consecutive failures beyond threshold.
 */
export function calculateBackoffDuration(failedAttempts: number): number {
  if (failedAttempts < LOCKOUT_THRESHOLD) {
    return 0;
  }
  const excess = failedAttempts - LOCKOUT_THRESHOLD;
  const backoff = BASE_LOCKOUT_SECONDS * Math.pow(2, excess);
  return Math.min(MAX_LOCKOUT_SECONDS, Math.round(backoff));
}

/**
 * Checks whether an account or IP identifier is currently locked out.
 */
export async function isLockedOut(identifier: string): Promise<{
  locked: boolean;
  lockedUntilMs?: number;
  remainingSeconds?: number;
}> {
  const redis = getRedisClient();
  const now = Date.now();
  const normalized = identifier.trim().toLowerCase();

  if (redis) {
    try {
      const untilStr = await redis.get(`lockout:until:${normalized}`);
      if (untilStr) {
        const lockedUntilMs = parseInt(untilStr, 10);
        if (now < lockedUntilMs) {
          const remainingSeconds = Math.ceil((lockedUntilMs - now) / 1000);
          return { locked: true, lockedUntilMs, remainingSeconds };
        }
      }
      return { locked: false };
    } catch (err) {
      logger.warn("Redis lockout check error, falling back to in-memory store", { identifier, err });
    }
  }

  // Fallback to in-memory store
  const record = inMemoryStore.get(normalized);
  if (record && record.lockedUntilMs > now) {
    const remainingSeconds = Math.ceil((record.lockedUntilMs - now) / 1000);
    return { locked: true, lockedUntilMs: record.lockedUntilMs, remainingSeconds };
  }

  return { locked: false };
}

/**
 * Records a failed login attempt for the given identifier (account/email/IP).
 * Increments failure count, applies exponential backoff if threshold met, and sends email notification on initial lockout.
 */
export async function recordFailedAttempt(
  identifier: string,
  accountEmail?: string,
  ipAddress?: string
): Promise<{
  locked: boolean;
  failedAttempts: number;
  lockedUntilMs?: number;
  lockoutDurationSeconds?: number;
}> {
  const redis = getRedisClient();
  const now = Date.now();
  const normalized = identifier.trim().toLowerCase();

  let failedAttempts = 1;
  let lockoutDuration = 0;

  if (redis) {
    try {
      const countKey = `lockout:failed_count:${normalized}`;
      const untilKey = `lockout:until:${normalized}`;

      const newCount = await redis.incr(countKey);
      failedAttempts = newCount;
      await redis.expire(countKey, SLIDING_WINDOW_SECONDS);

      lockoutDuration = calculateBackoffDuration(failedAttempts);
      let lockedUntilMs: number | undefined = undefined;

      if (lockoutDuration > 0) {
        lockedUntilMs = now + lockoutDuration * 1000;
        await redis.setex(untilKey, lockoutDuration, lockedUntilMs.toString());
      }

      if (failedAttempts >= LOCKOUT_THRESHOLD && accountEmail) {
        sendLockoutNotificationEmail(
          accountEmail,
          Math.max(1, Math.ceil(lockoutDuration / 60)),
          ipAddress
        ).catch((err) =>
          logger.error("Failed to send lockout notification email", { accountEmail, err })
        );
      }

      return {
        locked: lockoutDuration > 0,
        failedAttempts,
        lockedUntilMs,
        lockoutDurationSeconds: lockoutDuration,
      };
    } catch (err) {
      logger.warn("Redis lockout record error, using in-memory store", { identifier, err });
    }
  }

  // In-memory fallback
  let record = inMemoryStore.get(normalized);
  if (!record || now - record.lastFailedAtMs > SLIDING_WINDOW_SECONDS * 1000) {
    record = { failedAttempts: 1, lockedUntilMs: 0, lastFailedAtMs: now };
  } else {
    record.failedAttempts += 1;
    record.lastFailedAtMs = now;
  }

  failedAttempts = record.failedAttempts;
  lockoutDuration = calculateBackoffDuration(failedAttempts);
  let lockedUntilMs: number | undefined = undefined;

  if (lockoutDuration > 0) {
    lockedUntilMs = now + lockoutDuration * 1000;
    record.lockedUntilMs = lockedUntilMs;
  }

  inMemoryStore.set(normalized, record);

  if (failedAttempts >= LOCKOUT_THRESHOLD && accountEmail) {
    sendLockoutNotificationEmail(
      accountEmail,
      Math.max(1, Math.ceil(lockoutDuration / 60)),
      ipAddress
    ).catch((err) =>
      logger.error("Failed to send lockout notification email", { accountEmail, err })
    );
  }

  return {
    locked: lockoutDuration > 0,
    failedAttempts,
    lockedUntilMs,
    lockoutDurationSeconds: lockoutDuration,
  };
}

/**
 * Resets failed attempt counter and clears lockout state upon successful login or password reset.
 */
export async function resetLockoutState(identifier: string): Promise<void> {
  const redis = getRedisClient();
  const normalized = identifier.trim().toLowerCase();

  if (redis) {
    try {
      await redis.del(`lockout:failed_count:${normalized}`, `lockout:until:${normalized}`);
    } catch (err) {
      logger.warn("Redis lockout reset error", { identifier: normalized, err });
    }
  }

  inMemoryStore.delete(normalized);
}

/** Helper for tests / cleanup */
export function _clearInMemoryLockouts(): void {
  inMemoryStore.clear();
}
