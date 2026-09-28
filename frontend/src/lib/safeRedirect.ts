// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Shared open-redirect guard (issue #759).
 *
 * Every code path that redirects based on a request-supplied parameter must
 * pass the target through `resolveSafeRedirect` — external / unallowlisted
 * targets are rejected (callers fall back to `/`) rather than followed.
 */

export const DEFAULT_SAFE_REDIRECT = "/";

/** In-app path prefixes a post-action redirect is allowed to land on. */
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

/**
 * True only for same-origin, allowlisted in-app targets:
 * - must start with exactly one `/` (rejects `//evil`, `/\evil`, `\/`)
 * - rejects scheme-relative, absolute-URL, protocol, CR/LF, and
 *   javascript:/data: payloads (case-insensitive, incl. whitespace padding)
 * - must match `/` exactly or one of the allowlisted prefixes as a full
 *   path segment (so `/dashboard2` does not pass via `/dashboard`)
 */
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
  // Encoded slashes / backslashes that would escape to a host (`/%5c`, `/%2f`).
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

/**
 * Returns the redirect target when it is safe, otherwise the fallback
 * (default `/`). Never throws — unallowlisted input is ignored, not followed.
 */
export function resolveSafeRedirect(
  raw: unknown,
  fallback: string = DEFAULT_SAFE_REDIRECT
): string {
  if (isSafeRedirectTarget(raw)) return (raw as string).trim();
  if (isSafeRedirectTarget(fallback)) return fallback;
  return DEFAULT_SAFE_REDIRECT;
}
