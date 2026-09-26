// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { createHmac, timingSafeEqual } from "crypto";
import { isIP, isIPv4 } from "net";
import { RequestHandler, Request } from "express";
import logger from "../utils/logger.js";
import { notFoundHandler } from "./notFound.js";

/**
 * Optional network-layer allowlist for the privileged admin surface.
 *
 * Everything reachable through the admin routers is already gated by
 * authentication (JWT role) and, for most routes, `requireAdmin`. This adds an
 * independent network control so that a stolen admin credential is not, by
 * itself, enough to reach those endpoints: the request must *also* originate
 * from an allowlisted address.
 *
 * ## Enablement
 *
 * Like this codebase's other risk controls (fee switches, permissioned mode,
 * lockups) the feature is **opt-in**: with `ADMIN_IP_ALLOWLIST` unset or empty
 * the middleware is inert and requests pass through untouched, so enabling it is
 * a deliberate deployment step. Once any valid entry is configured the policy
 * becomes a strict allowlist — everything not matched is rejected.
 *
 * ## Rejection is a generic 404
 *
 * A blocked request is answered with the same `notFoundHandler` payload that a
 * genuinely unmatched path produces, and the rejection happens *before* any
 * authentication middleware runs. Returning 401/403 would confirm to an
 * off-network prober that the route exists and merely needs better credentials;
 * a 404 keeps the admin surface from leaking its own shape. Consequence: an
 * operator hitting a 404 on a real admin route while off-network gets no
 * diagnostic hint from the body, so the rejection is logged server-side instead
 * (IP, method, path) — the audit trail is for operators, the client sees nothing.
 *
 * ## Client IP and proxy trust
 *
 * `req.ip` only reflects the true peer when Express is told how many proxies to
 * believe. The app sets `trust proxy` from `TRUST_PROXY` via
 * `resolveTrustProxy()` below. Getting this wrong is the one way this control
 * can silently invert:
 *
 *   - too little trust  -> every request appears to come from the ingress, so
 *     the allowlist evaluates the load balancer rather than the operator and
 *     either locks everyone out or locks nobody out;
 *   - blind trust (`true`) -> any caller can forge `X-Forwarded-For` and pick its
 *     own allowlisted address, which defeats the control entirely.
 *
 * The default (`false`) trusts only the socket peer, which is correct for a
 * directly-exposed server and fails closed behind a proxy.
 */

/** Header carrying the break-glass override token. */
export const ADMIN_IP_BYPASS_HEADER = "x-admin-ip-override";

/** Default and hard ceiling on override lifetime, in seconds. */
export const DEFAULT_BYPASS_TTL_SECONDS = 900; // 15 minutes
export const MAX_BYPASS_TTL_SECONDS = 3600; // 1 hour

type IpRange =
  | { family: 4; network: number; mask: number }
  | { family: 6; network: bigint; mask: bigint };

export interface AdminIpAllowlistConfig {
  /** Successfully parsed entries. Empty when the control is disabled. */
  ranges: IpRange[];
  /** Entries that failed to parse. Logged once at load; never matched. */
  invalidEntries: string[];
  /** True when at least one valid entry is configured. */
  enabled: boolean;
  /** HMAC key for the break-glass override, or null when it is disabled. */
  bypassSecret: string | null;
  /** Upper bound on how long an override may be accepted. */
  bypassTtlSeconds: number;
}

// ── Address parsing ─────────────────────────────────────────────────────

/** Parses a dotted-quad into an unsigned 32-bit integer, or null. */
function parseIPv4(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    // Reject empty octets and leading zeros, which `Number()` would otherwise
    // accept as octal-ish or coerce silently.
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value * 256 + octet) >>> 0;
  }
  return value;
}

/** Parses a (possibly `::`-compressed) IPv6 literal into a 128-bit integer. */
function parseIPv6(address: string): bigint | null {
  let text = address;

  // Drop a zone index such as fe80::1%eth0 — it is local routing metadata, not
  // part of the address.
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);

  // Rewrite a trailing dotted-quad (::ffff:192.0.2.1) into two hextets so the
  // group logic below only ever deals with hex.
  const embedded = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (embedded) {
    const v4 = parseIPv4(embedded[1]);
    if (v4 === null) return null;
    const high = ((v4 >>> 16) & 0xffff).toString(16);
    const low = (v4 & 0xffff).toString(16);
    text = `${text.slice(0, embedded.index)}${high}:${low}`;
  }

  const toBigInt = (groups: string[]): bigint | null => {
    let value = 0n;
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      value = (value << 16n) + BigInt(`0x${group}`);
    }
    return value;
  };

  if (!text.includes("::")) {
    const groups = text.split(":");
    if (groups.length !== 8) return null;
    return toBigInt(groups);
  }

  const halves = text.split("::");
  if (halves.length !== 2) return null; // more than one "::" is invalid
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  // "::" must stand for at least one omitted group.
  if (head.length + tail.length > 7) return null;
  const filler = new Array(8 - head.length - tail.length).fill("0");
  return toBigInt([...head, ...filler, ...tail]);
}

/**
 * Collapses an IPv4-mapped IPv6 address to its dotted-quad form.
 *
 * When a dual-stack server accepts an IPv4 client the peer address surfaces as
 * `::ffff:203.0.113.7`. Without this, an operator allowlisting their own
 * public IPv4 would be denied on a socket that happened to be IPv6.
 */
function normalizeAddress(address: string): string {
  const mapped = address.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  return mapped ? mapped[1] : address;
}

/** Parses one allowlist entry (`1.2.3.4`, `10.0.0.0/8`, `2001:db8::/32`). */
function parseRange(entry: string): IpRange | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;

  const slash = trimmed.indexOf("/");
  const addressPart = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const prefixPart = slash === -1 ? undefined : trimmed.slice(slash + 1);
  const address = normalizeAddress(addressPart);

  const version = isIP(address);
  if (version === 0) return null;

  const maxBits = version === 4 ? 32 : 128;
  let prefix = maxBits;
  if (prefixPart !== undefined) {
    if (!/^\d{1,3}$/.test(prefixPart)) return null;
    prefix = Number(prefixPart);
    if (prefix > maxBits) return null;
  }

  if (version === 4) {
    const network = parseIPv4(address);
    if (network === null) return null;
    // `prefix === 0` must short-circuit: in 32-bit JS arithmetic a shift of 32
    // wraps back to 0 and would otherwise yield an all-ones mask.
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return { family: 4, network, mask };
  }

  const network = parseIPv6(address);
  if (network === null) return null;
  const allOnes = 0xffffffffffffffffffffffffffffffffn;
  const mask = prefix === 0 ? 0n : (allOnes << BigInt(128 - prefix)) & allOnes;
  return { family: 6, network, mask };
}

/** True when `address` falls inside `range`. Families never cross-match. */
function rangeMatches(range: IpRange, address: string): boolean {
  const normalized = normalizeAddress(address);

  if (range.family === 4) {
    if (!isIPv4(normalized)) return false;
    const value = parseIPv4(normalized);
    if (value === null) return false;
    return (value & range.mask) === (range.network & range.mask);
  }

  if (isIP(normalized) !== 6) return false;
  const value = parseIPv6(normalized);
  if (value === null) return false;
  return (value & range.mask) === (range.network & range.mask);
}

// ── Configuration ───────────────────────────────────────────────────────

/**
 * Reads the allowlist from the environment.
 *
 * Invalid entries are collected rather than thrown: one typo should not crash
 * the API, but it must also never widen the policy, so the bad value is dropped
 * from the parsed set and reported.
 */
export function loadAdminIpAllowlistConfig(
  env: NodeJS.ProcessEnv = process.env,
): AdminIpAllowlistConfig {
  const entries = (env.ADMIN_IP_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const ranges: IpRange[] = [];
  const invalidEntries: string[] = [];
  for (const entry of entries) {
    const parsed = parseRange(entry);
    if (parsed) ranges.push(parsed);
    else invalidEntries.push(entry);
  }

  const secret = env.ADMIN_IP_BYPASS_SECRET?.trim();
  const requestedTtl = Number(env.ADMIN_IP_BYPASS_TTL_SECONDS);
  const ttl =
    Number.isInteger(requestedTtl) && requestedTtl > 0 ? requestedTtl : DEFAULT_BYPASS_TTL_SECONDS;

  return {
    ranges,
    invalidEntries,
    enabled: ranges.length > 0,
    bypassSecret: secret ? secret : null,
    // Clamping means a captured token is only ever useful for a bounded window,
    // even if whoever holds the secret signs a long expiry.
    bypassTtlSeconds: Math.min(ttl, MAX_BYPASS_TTL_SECONDS),
  };
}

/**
 * Resolves Express's `trust proxy` setting from `TRUST_PROXY`.
 *
 * Accepts `false` (default, trust the socket only), a hop count, a comma
 * separated subnet list, or `true`. `true` is honoured but is spoofable by any
 * client able to set `X-Forwarded-For`, so `index.ts` warns when it is selected.
 */
export type TrustProxySetting = boolean | number | string;

export function resolveTrustProxy(env: NodeJS.ProcessEnv = process.env): TrustProxySetting {
  const raw = env.TRUST_PROXY?.trim();
  if (!raw) return false;
  // Digits are tested before the boolean words so TRUST_PROXY=1 means "one
  // proxy hop" rather than `true`. Collapsing the two would silently promote
  // the most common production value into "believe any X-Forwarded-For".
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    // Zero hops is the same policy as the default; report it as `false` so the
    // "trust nothing" state has one representation.
    return hops === 0 ? false : hops;
  }
  if (/^(false|off|no)$/i.test(raw)) return false;
  if (/^(true|on|yes)$/i.test(raw)) return true;
  return raw; // e.g. "10.0.0.0/8,172.16.0.0/12"
}

// ── Break-glass override ────────────────────────────────────────────────

/**
 * The request path as the client would write it in the request line, with any
 * query string and trailing slash removed.
 *
 * `req.path` is relative to the mount point — inside `app.use("/api/admin", …)`
 * it reads `/stats`, not `/api/admin/stats` — so it cannot be used to bind an
 * override signature. `originalUrl` is the full target, and normalising the
 * trailing slash keeps `/api/admin` and `/api/admin/` from needing two tokens.
 */
function requestPath(req: Request): string {
  const path = (req.originalUrl || req.url || "/").split("?")[0];
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Canonical string an override token is signed over.
 *
 * Binding the signature to the method, path and *real client IP* means a token
 * captured in transit cannot be replayed from a different host against a
 * different endpoint — it authorises exactly one action, from one place, for a
 * short time.
 */
function overrideMessage(
  method: string,
  path: string,
  clientIp: string,
  expiresAt: number,
): string {
  return `${method.toUpperCase()}\n${path}\n${clientIp}\n${expiresAt}`;
}

/** Constant-time comparison of two hex digests of equal length. */
function digestsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function verifyOverride(
  req: Request,
  config: AdminIpAllowlistConfig,
  clientIp: string,
  nowSeconds: number,
): number | null {
  if (!config.bypassSecret) return null;

  const raw = req.headers[ADMIN_IP_BYPASS_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token) return null;

  const separator = token.indexOf(".");
  if (separator === -1) return null;
  const expiresAt = Number(token.slice(0, separator));
  const provided = token.slice(separator + 1);
  if (!Number.isInteger(expiresAt) || !/^[0-9a-f]{64}$/i.test(provided)) return null;

  if (expiresAt <= nowSeconds) return null; // already lapsed
  if (expiresAt - nowSeconds > config.bypassTtlSeconds) return null; // outlives policy

  const expected = createHmac("sha256", config.bypassSecret)
    .update(overrideMessage(req.method, requestPath(req), clientIp, expiresAt))
    .digest("hex");
  if (!digestsMatch(expected, provided.toLowerCase())) return null;

  return expiresAt;
}

// ── Middleware ───────────────────────────────────────────────────────────

/**
 * Builds the gate over an already-resolved config so tests can drive it
 * without mutating `process.env`.
 */
export function createAdminIpAllowlist(config: AdminIpAllowlistConfig): RequestHandler {
  return function adminIpAllowlist(req, res, next): void {
    if (!config.enabled) {
      next();
      return;
    }

    const clientIp = req.ip ?? req.socket?.remoteAddress ?? "";
    if (clientIp && config.ranges.some((range) => rangeMatches(range, clientIp))) {
      next();
      return;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAt = verifyOverride(req, config, clientIp, nowSeconds);
    if (expiresAt !== null) {
      // Break-glass use is always logged: a successful override is an
      // intentional, auditable exception to the network policy.
      logger.warn("Admin IP allowlist bypassed via signed override", {
        ip: clientIp,
        method: req.method,
        path: requestPath(req),
        expiresAt: new Date(expiresAt * 1000).toISOString(),
      });
      next();
      return;
    }

    logger.warn("Admin route rejected: client IP not in ADMIN_IP_ALLOWLIST", {
      ip: clientIp,
      method: req.method,
      path: requestPath(req),
    });
    notFoundHandler(req, res);
  };
}

/** Production instance used by `index.ts`. */
export const adminIpAllowlist = createAdminIpAllowlist(loadAdminIpAllowlistConfig());
