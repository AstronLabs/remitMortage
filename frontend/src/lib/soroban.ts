// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Formatting helpers for recurring schedule intervals and countdowns.
 *
 * These helpers convert raw seconds into human-readable cadence strings
 * (e.g. "every 30 days") and compute countdowns to the next disbursement
 * (e.g. "next in 4d 3h").
 */

const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Convert an interval in seconds to a human-readable cadence string.
 *
 * @example
 * formatInterval(86400)   // "every day"
 * formatInterval(604800)  // "every week"
 * formatInterval(2592000) // "every month"
 * formatInterval(1800)    // "every 30 minutes"
 */
export function formatInterval(seconds: number): string {
  if (seconds <= 0) return "instantly";

  if (seconds < MINUTE) {
    return seconds === 1 ? "every second" : `every ${seconds} seconds`;
  }
  if (seconds < HOUR) {
    const m = Math.round(seconds / MINUTE);
    return m === 1 ? "every minute" : `every ${m} minutes`;
  }
  if (seconds < DAY) {
    const h = Math.round(seconds / HOUR);
    return h === 1 ? "every hour" : `every ${h} hours`;
  }
  if (seconds < WEEK) {
    const d = Math.round(seconds / DAY);
    return d === 1 ? "every day" : `every ${d} days`;
  }
  if (seconds < MONTH) {
    const w = Math.round(seconds / WEEK);
    return w === 1 ? "every week" : `every ${w} weeks`;
  }
  if (seconds < YEAR) {
    const mo = Math.round(seconds / MONTH);
    return mo === 1 ? "every month" : `every ${mo} months`;
  }

  const y = Math.round(seconds / YEAR);
  return y === 1 ? "every year" : `every ${y} years`;
}

/**
 * Compute the time remaining until the next disbursement from a given
 * timestamp and format it as a countdown string.
 *
 * If the disbursement is already due, returns "due now".
 *
 * @param nextDisbursementUnix - Unix timestamp (seconds) of the next disbursement
 * @param nowUnix - Optional current Unix timestamp (seconds). Defaults to Math.floor(Date.now() / 1000).
 *
 * @example
 * // Assuming now = 1700000000
 * formatCountdown(1700000000)    // "due now"
 * formatCountdown(1700003600)    // "next in 1h"
 * formatCountdown(1700172800)    // "next in 2d"
 */
export function formatCountdown(
  nextDisbursementUnix: number,
  nowUnix?: number,
): string {
  const now = nowUnix ?? Math.floor(Date.now() / 1000);
  const diff = nextDisbursementUnix - now;

  if (diff <= 0) return "due now";

  if (diff < MINUTE) {
    return diff <= 5 ? "next in a few seconds" : `next in ${diff}s`;
  }
  if (diff < HOUR) {
    const m = Math.floor(diff / MINUTE);
    const s = diff % MINUTE;
    if (m >= 1 && s > 0) return `next in ${m}m ${s}s`;
    return m === 1 ? "next in 1m" : `next in ${m}m`;
  }
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR);
    const m = Math.floor((diff % HOUR) / MINUTE);
    if (h >= 1 && m > 0) return `next in ${h}h ${m}m`;
    return h === 1 ? "next in 1h" : `next in ${h}h`;
  }
  if (diff < WEEK) {
    const d = Math.floor(diff / DAY);
    const h = Math.floor((diff % DAY) / HOUR);
    if (d >= 1 && h > 0) return `next in ${d}d ${h}h`;
    return d === 1 ? "next in 1d" : `next in ${d}d`;
  }

  const w = Math.floor(diff / WEEK);
  const d = Math.floor((diff % WEEK) / DAY);
  if (w >= 1 && d > 0) return `next in ${w}w ${d}d`;
  return w === 1 ? "next in 1w" : `next in ${w}w`;
}
