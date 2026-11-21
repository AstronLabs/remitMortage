// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Breached-credential check for admin passwords (issue #979).
 *
 * Uses a k-anonymity range lookup: the password is SHA-1 hashed locally and
 * only the first five hex characters of the hash are sent. The service
 * returns every breached hash suffix sharing that prefix, and the match is
 * done here, so neither the password nor its full hash leaves the server.
 */

import { createHash } from "crypto";
import logger from "../utils/logger.js";

export const DEFAULT_RANGE_API_URL = "https://api.pwnedpasswords.com/range/";
export const ADMIN_PASSWORD_MIN_LENGTH = 12;
const LOOKUP_TIMEOUT_MS = 3_000;

/** Fetches the range body for a five-character hash prefix. */
export type RangeLookup = (prefix: string) => Promise<string>;

export const defaultRangeLookup: RangeLookup = async (prefix) => {
  const base = process.env.BREACHED_PASSWORD_API_URL || DEFAULT_RANGE_API_URL;
  const res = await fetch(`${base}${prefix}`, {
    // Padding hides the real size of the response from on-path observers.
    headers: { "Add-Padding": "true" },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`range lookup failed with HTTP ${res.status}`);
  return res.text();
};

export type BreachCheckResult = { status: "breached" } | { status: "clean" } | { status: "unavailable" };

/**
 * Checks a password against the breach list. Fails open: if the lookup
 * cannot be completed the result is "unavailable" and a warning is logged.
 */
export async function checkBreachedPassword(
  password: string,
  lookup: RangeLookup = defaultRangeLookup
): Promise<BreachCheckResult> {
  const hash = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  let body: string;
  try {
    body = await lookup(prefix);
  } catch (error) {
    logger.warn("Breached password lookup unavailable; allowing password", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "unavailable" };
  }

  for (const line of body.split(/\r?\n/)) {
    const [candidate, count] = line.trim().split(":");
    // Padding entries carry a count of 0 and are not real breaches.
    if (candidate?.toUpperCase() === suffix && Number(count) > 0) {
      return { status: "breached" };
    }
  }
  return { status: "clean" };
}

export type AdminPasswordCheck =
  | { ok: true }
  | { ok: false; error: "password_too_short" | "password_breached"; message: string };

/**
 * Policy for setting or changing an admin password: a minimum length, then
 * the breach check. The rejection message never says how often the password
 * appeared in breaches.
 */
export async function validateAdminPassword(
  password: string,
  lookup: RangeLookup = defaultRangeLookup
): Promise<AdminPasswordCheck> {
  if (typeof password !== "string" || password.length < ADMIN_PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      error: "password_too_short",
      message: `Password must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters.`,
    };
  }

  const result = await checkBreachedPassword(password, lookup);
  if (result.status === "breached") {
    return {
      ok: false,
      error: "password_breached",
      message: "This password has appeared in a known data breach. Choose a different password.",
    };
  }
  return { ok: true };
}
