// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import cron from "node-cron";
import {
  DEFAULT_ROTATION_INTERVAL_SECONDS,
  getJwtKeyRing,
  nowSeconds,
} from "../services/jwtKeyRing.js";
import logger from "../utils/logger.js";

/**
 * JWT Session-Signing Key Auto-Rotation Scheduler
 *
 * On a schedule, rotates the session signing key once the current key is older
 * than `JWT_KEY_ROTATION_INTERVAL_SECONDS`, then prunes any retired key whose
 * grace period has fully elapsed. The previous key keeps validating tokens
 * throughout the grace period, so active sessions are never disrupted.
 *
 * Schedule can be customized via JWT_KEY_ROTATION_CRON_SCHEDULE.
 */
let rotationTask: ReturnType<typeof cron.schedule> | null = null;

export function startJwtKeyRotationScheduler(): void {
  if (rotationTask) {
    logger.info("[jwt-rotation] scheduler already running, ignoring start request");
    return;
  }

  const schedule = process.env.JWT_KEY_ROTATION_CRON_SCHEDULE || "0 4 * * *";

  rotationTask = cron.schedule(
    schedule,
    () => {
      runJwtKeyRotationSweep();
    },
    { timezone: "UTC" }
  );

  logger.info("[jwt-rotation] scheduler started", { schedule });
}

export function stopJwtKeyRotationScheduler(): void {
  if (rotationTask) {
    rotationTask.stop();
    rotationTask = null;
    logger.info("[jwt-rotation] scheduler stopped");
  }
}

/**
 * Runs one rotation sweep. Exported so it can also be triggered manually
 * (tests, admin tooling) without waiting for the cron tick.
 */
export function runJwtKeyRotationSweep(now: number = nowSeconds()): {
  rotated: boolean;
  pruned: string[];
} {
  const ring = getJwtKeyRing();
  const interval = intFromEnv(
    process.env.JWT_KEY_ROTATION_INTERVAL_SECONDS,
    DEFAULT_ROTATION_INTERVAL_SECONDS
  );

  const kidsBefore = ring.snapshot().map((key) => key.kid);
  const age = now - ring.currentKey.createdAt;
  let rotated = false;
  if (age >= interval) {
    const newKey = ring.rotate(now);
    rotated = true;
    logger.info("[jwt-rotation] rotated session signing key", {
      newKid: newKey.kid,
      previousKid: ring.snapshot()[1]?.kid,
    });
  }

  // Retired keys are removed only after their grace period has fully elapsed.
  // Compare the ring before/after so a key pruned as part of the rotation above
  // is still reported.
  ring.prune(now);
  const kidsAfter = new Set(ring.snapshot().map((key) => key.kid));
  const pruned = kidsBefore.filter((kid) => !kidsAfter.has(kid));
  if (pruned.length > 0) {
    logger.info("[jwt-rotation] pruned expired session keys", { pruned });
  }

  return { rotated, pruned };
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
