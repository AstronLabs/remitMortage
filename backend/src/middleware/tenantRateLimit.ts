// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import type { Request, Response, NextFunction } from "express";
import { getCurrentTenant } from "../services/tenant.js";
import { entitlements, type EntitlementService, type PlanId } from "../services/entitlements.js";
import { tenantRateLimitExceededTotal, tenantRateLimitUsage } from "../services/metrics.js";
import { GLOBAL_RATE_LIMIT_MAX } from "./rateLimit.js";

export const TENANT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const TENANT_CAPACITY_SHARE = 0.8;
export const MAX_TENANT_REQUESTS_PER_MINUTE = Math.floor(
  GLOBAL_RATE_LIMIT_MAX * TENANT_CAPACITY_SHARE
);

interface TenantRateLimitRequest extends Request {
  user?: unknown;
  adminAuth?: unknown;
  tenantRateLimitApplied?: boolean;
}

interface TenantWindow {
  windowStart: number;
  requestCount: number;
}

const tenantWindows = new Map<string, TenantWindow>();

export function tenantRequestLimit(
  tenantId: string,
  service: EntitlementService = entitlements
): { plan: PlanId; limit: number } {
  const plan = service.getPlan(tenantId);
  const planLimit = plan.limits.apiRequestsPerMinute;
  if (!Number.isSafeInteger(planLimit) || planLimit <= 0) {
    throw new Error(`Invalid apiRequestsPerMinute limit for tenant plan ${plan.id}`);
  }
  return { plan: plan.id, limit: Math.min(planLimit, MAX_TENANT_REQUESTS_PER_MINUTE) };
}

/**
 * Apply a plan-based request budget to authenticated tenant traffic.
 * The per-tenant ceiling stays below the shared per-IP ceiling, reserving
 * 20% of that baseline for traffic from other tenants.
 */
export function tenantRateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authenticatedRequest = req as TenantRateLimitRequest;
  if ((!authenticatedRequest.user && !authenticatedRequest.adminAuth) ||
      authenticatedRequest.tenantRateLimitApplied) {
    next();
    return;
  }
  authenticatedRequest.tenantRateLimitApplied = true;

  const tenantId = getCurrentTenant().id;
  const { plan, limit } = tenantRequestLimit(tenantId);
  const now = Date.now();
  const windowStart = Math.floor(now / TENANT_RATE_LIMIT_WINDOW_MS) * TENANT_RATE_LIMIT_WINDOW_MS;
  const resetAt = windowStart + TENANT_RATE_LIMIT_WINDOW_MS;
  let window = tenantWindows.get(tenantId);

  if (!window || window.windowStart !== windowStart) {
    window = { windowStart, requestCount: 0 };
    tenantWindows.set(tenantId, window);
  }

  window.requestCount += 1;
  const remaining = Math.max(0, limit - window.requestCount);
  const resetUnixSeconds = Math.ceil(resetAt / 1000);
  const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));

  res.setHeader("X-Tenant-RateLimit-Limit", String(limit));
  res.setHeader("X-Tenant-RateLimit-Remaining", String(remaining));
  res.setHeader("X-Tenant-RateLimit-Reset", String(resetUnixSeconds));
  tenantRateLimitUsage.set({ tenant_id: tenantId, plan }, window.requestCount);

  if (window.requestCount > limit) {
    tenantRateLimitExceededTotal.inc({ tenant_id: tenantId, plan });
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({
      error: "tenant_rate_limit_exceeded",
      message: `Tenant request limit of ${limit} requests per minute exceeded`,
      tenantId,
      limit,
      resetAt: new Date(resetAt).toISOString(),
      retryAfter,
      statusCode: 429,
    });
    return;
  }

  next();
}
