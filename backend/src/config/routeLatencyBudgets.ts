// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Per-route latency budgets (issue #988).
 *
 * Every route is compared with an expected latency. Routes not listed use
 * `defaultMs`, so a newly added endpoint is covered without extra work.
 * Keys are `"<METHOD> <route template>"`, using the same template the HTTP
 * metrics label (`/api/loan/:id`), never a concrete URL.
 */

export interface RouteLatencyBudgetConfig {
  /** Budget for any route without an explicit entry. */
  defaultMs: number;
  /** `"METHOD /route/template"` → budget in milliseconds. */
  routes: Readonly<Record<string, number>>;
}

export const ROUTE_LATENCY_BUDGETS: RouteLatencyBudgetConfig = {
  defaultMs: 500,
  routes: {
    "GET /api/health": 250,
    "GET /api/health/live": 100,
    "GET /api/health/ready": 250,
    "GET /api/status": 500,
    "GET /api/health/rpc": 1_000,
    "POST /api/verification/check": 2_000,
    "POST /api/verification/score": 2_000,
    "GET /api/borrower/:address/status": 750,
    "GET /api/analytics/overview": 1_000,
    "GET /api/analytics/loans": 1_000,
    "GET /api/analytics/disbursement": 1_000,
    "GET /api/audit-logs": 1_000,
    "GET /metrics": 1_000,
  },
};

/** The map key for a method and route template. */
export function latencyBudgetKey(method: string, route: string): string {
  return `${method.toUpperCase()} ${route}`;
}

/**
 * Budget for one request. Looks up the exact method+route entry first, then a
 * method-less entry, then the default.
 */
export function resolveLatencyBudget(
  method: string,
  route: string,
  config: RouteLatencyBudgetConfig = ROUTE_LATENCY_BUDGETS
): number {
  return (
    config.routes[latencyBudgetKey(method, route)] ??
    config.routes[route] ??
    config.defaultMs
  );
}
