// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Canonical inventory of every code path that redirects based on a
 * request-supplied parameter (issue #759).
 *
 * Each entry names the validation that rejects external/unallowlisted
 * targets. The audit suite (`src/__tests__/openRedirectAudit.test.ts`) and
 * the CI gate (`scripts/check-redirect-coverage.mjs`) read this registry:
 * adding a new redirect-accepting path without registering it (with a test)
 * fails CI.
 */

export interface RedirectPathEntry {
  /** Where the redirect lives, e.g. "frontend/src/middleware.ts". */
  location: string;
  /** Request-supplied parameter that carries the target. */
  param: string;
  /** Validation that must run before the target is followed. */
  validation: string;
  /** Test asserting an external target is rejected, not followed. */
  coveredBy: string;
}

export const REDIRECT_PATH_REGISTRY: RedirectPathEntry[] = [
  {
    location: "frontend/src/middleware.ts (protected-route gate)",
    param: "redirect",
    validation: "resolveSafeRedirect — only allowlisted in-app paths are stored on the login URL; anything else falls back to /",
    coveredBy: "frontend/src/lib/__tests__/safeRedirect.test.ts + backend/src/__tests__/openRedirectAudit.test.ts",
  },
  {
    location: "frontend post-login consumer (reads ?redirect= after sign-in)",
    param: "redirect",
    validation: "resolveSafeRedirect(value, /dashboard) before router.push — external targets resolve to the fallback",
    coveredBy: "frontend/src/lib/__tests__/safeRedirect.test.ts + backend/src/__tests__/openRedirectAudit.test.ts",
  },
  {
    location: "backend/src/security/redirectValidation.ts getSafeRedirectTarget (post-action return-to / return_to / next / callbackUrl / redirectUrl)",
    param: "returnTo | return_to | next | callbackUrl | redirectUrl | redirect",
    validation: "getSafeRedirectTarget — allowlisted same-origin path or fallback; raw value is never passed to res.redirect",
    coveredBy: "backend/src/__tests__/openRedirectAudit.test.ts",
  },
];
