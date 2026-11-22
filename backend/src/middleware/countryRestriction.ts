// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { type RequestHandler } from "express";
import logger from "../utils/logger.js";
import { getIpGeoLocation } from "../services/locationAnomalyService.js";
import { type IpRange, parseRange, rangeMatches } from "./adminIpAllowlist.js";

/**
 * Country-level access restriction (issue #1029).
 *
 * Blocks API access from jurisdictions the protocol is not permitted to serve.
 * The request IP is resolved to a country via the existing geo-IP lookup
 * (`getIpGeoLocation`, the same resolver used for login anomaly detection).
 * Requests from a restricted country are rejected with a clear, non-specific
 * 403 that does not reveal the restriction logic (no country name, no mention
 * of sanctions or geo-blocking in the response body).
 *
 * An admin-managed override list of CIDR IP ranges (`COUNTRY_OVERRIDE_IP_RANGES`)
 * bypasses the country check for known-safe networks such as internal tooling,
 * VPN exits, or compliance workstations that may route through a restricted
 * jurisdiction.
 *
 * The middleware is inert when `RESTRICTED_COUNTRIES` is unset or empty —
 * every request passes through unchanged.
 *
 * ## Trust proxy
 *
 * `req.ip` only reflects the true client when Express is told how many proxies
 * to believe. `index.ts` sets `trust proxy` from `TRUST_PROXY` via
 * `resolveTrustProxy()` (exported from `adminIpAllowlist.js`). Getting this
 * wrong is the one way this control can silently invert — see the trust-proxy
 * documentation in `adminIpAllowlist.ts`.
 */

export interface CountryRestrictionConfig {
  /** Upper-cased ISO 3166-1 alpha-2 codes of blocked countries. */
  restrictedCountries: Set<string>;
  /** Parsed CIDR ranges that bypass the country check. */
  overrideRanges: IpRange[];
  /** True when at least one restricted country is configured. */
  enabled: boolean;
}

/**
 * Reads the country-restriction config from the environment.
 *
 * Invalid CIDR entries in the override list are silently dropped (one typo
 * should not crash the API, but it must also never widen the policy).
 */
export function loadCountryRestrictionConfig(
  env: NodeJS.ProcessEnv = process.env,
): CountryRestrictionConfig {
  const countries = String(env.RESTRICTED_COUNTRIES ?? "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);

  const rangeEntries = String(env.COUNTRY_OVERRIDE_IP_RANGES ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  const overrideRanges: IpRange[] = [];
  for (const entry of rangeEntries) {
    const parsed = parseRange(entry);
    if (parsed) overrideRanges.push(parsed);
  }

  return {
    restrictedCountries: new Set(countries),
    overrideRanges,
    enabled: countries.length > 0,
  };
}

/**
 * Builds the country-restriction gate over an already-resolved config so tests
 * can drive it without mutating `process.env`.
 */
export function createCountryRestriction(
  config: CountryRestrictionConfig,
): RequestHandler {
  return function countryRestriction(req, res, next): void {
    if (!config.enabled) {
      next();
      return;
    }

    // Resolve the client IP. With `trust proxy` set, `req.ip` is the real
    // client address. The X-Forwarded-For fallback handles the case where
    // trust proxy is not configured (reading the first hop only).
    const forwarded = req.headers["x-forwarded-for"];
    const forwardedIp = Array.isArray(forwarded)
      ? forwarded[0]
      : forwarded?.split(",")[0].trim();
    const clientIp = req.ip ?? forwardedIp ?? req.socket?.remoteAddress ?? "127.0.0.1";

    // Override: known-safe IP ranges (e.g. internal tooling) bypass the
    // country check entirely, even if the geo-IP resolver places them in a
    // restricted country.
    if (config.overrideRanges.some((range) => rangeMatches(range, clientIp))) {
      next();
      return;
    }

    const location = getIpGeoLocation(clientIp);
    if (config.restrictedCountries.has(location.country)) {
      // The rejection is logged server-side (country, IP, path) for
      // operators. The client sees only a generic 403 — no country name,
      // no mention of the restriction mechanism, so the blocked caller
      // cannot infer why access was denied.
      logger.warn("Request blocked by country restriction", {
        ip: clientIp,
        country: location.country,
        method: req.method,
        path: req.path,
      });
      res.status(403).json({
        error: "access_denied",
        message: "Access denied",
      });
      return;
    }

    next();
  };
}

/** Production instance used by `index.ts`. */
export const countryRestriction = createCountryRestriction(
  loadCountryRestrictionConfig(),
);
