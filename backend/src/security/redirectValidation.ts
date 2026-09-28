// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Backend twin of the frontend safe-redirect guard (issue #759).
 *
 * Kept dependency-free so route handlers, email click-through links, and
 * post-payment return URLs can validate request-supplied redirect targets
 * without importing frontend code. Semantics mirror
 * `frontend/src/lib/safeRedirect.ts` exactly.
 */

export const DEFAULT_SAFE_REDIRECT = "/";

export const ALLOWED_REDIRECT_PREFIXES = [
  "/dashboard",
  "/onboarding",
  "/application",
  "/invest",
  "/governance",
  "/settings",
  "/history",
  "/contractor",
  "/repay",
  "/verify",
  "/tx",
  "/share",
  "/admin",
  "/",
];

export function isSafeRedirectTarget(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const target = raw.trim();
  if (target.length === 0 || target.length > 2048) return false;
  if (/[\r\n\u0000]/.test(target)) return false;
  if (!target.startsWith("/")) return false;
  if (target.startsWith("//") || target.startsWith("/\\")) return false;
  const lower = target.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("data:") ||
    lower.startsWith("vbscript:")
  ) {
    return false;
  }
  if (/%(2f|5c)/i.test(target.slice(1, 4))) return false;
  if (target.includes("://")) return false;

  const pathname = target.split(/[?#]/)[0] ?? "/";
  if (pathname === "/") return true;
  return ALLOWED_REDIRECT_PREFIXES.some(
    (prefix) =>
      prefix !== "/" &&
      (pathname === prefix || pathname.startsWith(`${prefix}/`))
  );
}

export function resolveSafeRedirect(
  raw: unknown,
  fallback = DEFAULT_SAFE_REDIRECT
): string {
  if (isSafeRedirectTarget(raw)) return (raw as string).trim();
  if (isSafeRedirectTarget(fallback)) return fallback;
  return DEFAULT_SAFE_REDIRECT;
}

/**
 * Express helper: validates `req.query[field]` / `req.body[field]` redirect
 * targets. Returns the safe target to follow; when the supplied value is
 * external/unallowlisted the caller must fall back (never `res.redirect`
 * the raw value).
 */
export function getSafeRedirectTarget(
  req: { query?: Record<string, unknown>; body?: Record<string, unknown> },
  fieldNames: string[] = ["redirect", "returnTo", "return_to", "next", "callbackUrl", "redirectUrl"],
  fallback = DEFAULT_SAFE_REDIRECT
): { target: string; rejected: string | null } {
  for (const field of fieldNames) {
    const raw = req.query?.[field] ?? req.body?.[field];
    if (raw === undefined) continue;
    if (isSafeRedirectTarget(raw)) return { target: (raw as string).trim(), rejected: null };
    return { target: fallback, rejected: String(raw).slice(0, 256) };
  }
  return { target: fallback, rejected: null };
}
