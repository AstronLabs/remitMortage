// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/** Below this much time left, the countdown switches to its urgent style. */
export const DEFAULT_URGENT_THRESHOLD_MS = 15 * 60 * 1000;

export interface OfferCountdownState {
  /** Milliseconds until expiry, never negative. */
  remainingMs: number;
  expired: boolean;
  urgent: boolean;
  /** "2d 03:04:05", "03:04:05" or "04:05". */
  label: string;
}

function toMs(expiresAt: string | number | Date): number {
  return expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
}

export function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = hours > 0 || days > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
  return days > 0 ? `${days}d ${clock}` : clock;
}

/**
 * Time left on an offer, computed from the offer's absolute deadline rather
 * than by decrementing a counter, so it stays accurate across throttled
 * timers, sleeping tabs and clock drift.
 */
export function getOfferCountdown(
  expiresAt: string | number | Date,
  now: number = Date.now(),
  urgentThresholdMs: number = DEFAULT_URGENT_THRESHOLD_MS
): OfferCountdownState {
  const deadline = toMs(expiresAt);
  const remainingMs = Number.isFinite(deadline) ? Math.max(0, deadline - now) : 0;
  const expired = remainingMs <= 0;
  return {
    remainingMs,
    expired,
    urgent: !expired && remainingMs <= urgentThresholdMs,
    label: formatRemaining(remainingMs),
  };
}

export function isOfferExpired(expiresAt: string | number | Date, now: number = Date.now()): boolean {
  return getOfferCountdown(expiresAt, now).expired;
}
