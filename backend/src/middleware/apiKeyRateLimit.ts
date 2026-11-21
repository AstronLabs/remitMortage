// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Request, Response, NextFunction } from "express";

/**
 * Per-API-key request rate limits tied to the key's subscription plan
 * (issue #1106).
 *
 * The baseline limiters in rateLimit.ts hold every caller to the same
 * per-IP ceiling, so a higher-tier integrator gets no practical headroom over
 * a free-tier one. This limiter keys on the API key instead and sizes its
 * window by `ApiKey.plan`.
 *
 * Distinct from `apiKeyQuota.ts`: that meters a long billing-period request
 * *quota*; this caps short-window request *rate*. Both read the plan from the
 * key `requireScopedApiKey` loads fresh from the database on every request,
 * so a plan change applies on the key's very next request with no cache to
 * invalidate.
 */

export interface ApiKeyRateLimitTier {
  /** Requests allowed per window. */
  max: number;
}

export interface ApiKeyRateLimitConfig {
  /** Fixed window length in milliseconds. */
  windowMs: number;
  /** Plan id → tier. */
  tiers: Record<string, ApiKeyRateLimitTier>;
  /** Plan applied to keys whose plan is not in `tiers`: the lowest tier. */
  fallbackPlan: string;
}

/**
 * Built-in plan tiers, lowest first. Overridable per deployment through
 * `API_KEY_RATE_LIMIT_BY_PLAN` (e.g. "free=60,pro=600,enterprise=3000").
 */
export const DEFAULT_API_KEY_RATE_LIMIT_TIERS: Record<string, ApiKeyRateLimitTier> = {
  free: { max: 60 },
  pro: { max: 600 },
  enterprise: { max: 3000 },
};

/**
 * Parses `API_KEY_RATE_LIMIT_BY_PLAN`, a comma-separated list of
 * `plan=requests` pairs. Malformed or non-positive entries are ignored.
 * Mirrors `apiKeyQuota.ts#parsePlanQuotas`'s parsing convention.
 */
export function parsePlanRateLimits(raw: string | undefined): Record<string, ApiKeyRateLimitTier> {
  const tiers: Record<string, ApiKeyRateLimitTier> = {};
  if (!raw) return tiers;
  for (const pair of raw.split(",")) {
    const separator = pair.lastIndexOf("=");
    if (separator <= 0) continue;
    const plan = pair.slice(0, separator).trim();
    const max = parseInt(pair.slice(separator + 1).trim(), 10);
    if (plan && Number.isFinite(max) && max > 0) tiers[plan] = { max };
  }
  return tiers;
}

/** The plan with the smallest allowance — where unrecognized plans land. */
export function lowestTierPlan(tiers: Record<string, ApiKeyRateLimitTier>): string {
  const entries = Object.entries(tiers);
  if (entries.length === 0) throw new Error("At least one API key rate limit tier is required");
  return entries.reduce((lowest, entry) => (entry[1].max < lowest[1].max ? entry : lowest))[0];
}

export function loadApiKeyRateLimitConfig(env: NodeJS.ProcessEnv = process.env): ApiKeyRateLimitConfig {
  const windowMs = parseInt(env.API_KEY_RATE_LIMIT_WINDOW_MS || "", 10);
  const overrides = parsePlanRateLimits(env.API_KEY_RATE_LIMIT_BY_PLAN);
  const tiers = Object.keys(overrides).length > 0 ? overrides : { ...DEFAULT_API_KEY_RATE_LIMIT_TIERS };
  return {
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60 * 1000,
    tiers,
    fallbackPlan: lowestTierPlan(tiers),
  };
}

/**
 * Resolves the tier for a key's plan, falling back to the lowest tier for an
 * unrecognized or missing plan so an unknown plan never grants more headroom.
 */
export function resolveApiKeyRateLimit(
  config: ApiKeyRateLimitConfig,
  plan: string | null | undefined
): { plan: string; max: number } {
  const known = typeof plan === "string" && Object.prototype.hasOwnProperty.call(config.tiers, plan);
  const effectivePlan = known ? (plan as string) : config.fallbackPlan;
  return { plan: effectivePlan, max: config.tiers[effectivePlan].max };
}

interface KeyWindow {
  windowStart: number;
  requestCount: number;
}

/** In-memory fixed-window counter per API key id. */
export class ApiKeyRateLimitStore {
  private readonly windows = new Map<string, KeyWindow>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  /** Counts one request for `keyId`, returning the post-increment count and seconds until the window resets. */
  hit(keyId: string): { requestCount: number; resetSeconds: number } {
    const now = this.now();
    const windowStart = Math.floor(now / this.windowMs) * this.windowMs;
    let window = this.windows.get(keyId);
    if (!window || window.windowStart !== windowStart) {
      window = { windowStart, requestCount: 0 };
      this.windows.set(keyId, window);
    }
    window.requestCount += 1;
    const resetSeconds = Math.max(0, Math.ceil((windowStart + this.windowMs - now) / 1000));
    return { requestCount: window.requestCount, resetSeconds };
  }

  reset(): void {
    this.windows.clear();
  }
}

/**
 * Rate-limits the request by the calling API key's plan tier. Sets the same
 * `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` headers the
 * global limiter already exposes (`standardHeaders`), so on key-authenticated
 * routes they describe the caller's own plan limit rather than the shared
 * per-IP one. Must be mounted after `requireScopedApiKey` / `requireAnyApiKey`,
 * which put the freshly loaded key on `res.locals.apiKey`.
 */
export function apiKeyRateLimiter(
  config: ApiKeyRateLimitConfig = loadApiKeyRateLimitConfig(),
  store: ApiKeyRateLimitStore = new ApiKeyRateLimitStore(config.windowMs)
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const apiKey = res.locals.apiKey as { id: string; plan?: string | null } | undefined;
    if (!apiKey) {
      // Nothing to key on — the auth middleware is what guards access.
      next();
      return;
    }

    const { plan, max } = resolveApiKeyRateLimit(config, apiKey.plan);
    const { requestCount, resetSeconds } = store.hit(apiKey.id);

    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, max - requestCount)));
    res.setHeader("RateLimit-Reset", String(resetSeconds));
    res.setHeader("RateLimit-Policy", `${max};w=${Math.ceil(config.windowMs / 1000)}`);
    res.setHeader("X-RateLimit-Plan", plan);

    if (requestCount > max) {
      const retryAfter = Math.max(1, resetSeconds);
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        error: "rate_limit_exceeded",
        message: `API key rate limit of ${max} requests per ${Math.ceil(config.windowMs / 1000)}s for plan "${plan}" exceeded`,
        plan,
        limit: max,
        retryAfter,
        statusCode: 429,
      });
      return;
    }

    next();
  };
}
