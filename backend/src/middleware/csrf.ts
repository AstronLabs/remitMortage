// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { randomBytes, timingSafeEqual } from "crypto";
import { Request, Response, NextFunction } from "express";

/**
 * CSRF protection using the stateless double-submit cookie pattern.
 *
 * A random token is stored in a **non-HttpOnly** cookie (so first-party client
 * JavaScript can read it) and must be echoed back in a request header on every
 * state-mutating request. A cross-site attacker can force the browser to send
 * the victim's cookies, but the same-origin policy prevents them from *reading*
 * the cookie value to replay it in the header — so the two never match and the
 * request is rejected.
 *
 * Requests authenticated with an `Authorization: Bearer` token are exempt:
 * those are not sent automatically by the browser (an attacker cannot set the
 * header cross-site), so they are not vulnerable to CSRF. This keeps mobile and
 * server-to-server clients working while protecting cookie-based sessions.
 */

export const CSRF_COOKIE = "csrfToken";
export const CSRF_HEADER = "x-csrf-token";

/**
 * Session cookies whose presence means the request is relying on ambient,
 * browser-attached authentication — the only case CSRF can exploit.
 */
const SESSION_COOKIES = ["token", "session"];

const CSRF_TOKEN_BYTES = 32;
const CSRF_COOKIE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

/** HTTP methods that never mutate state and therefore never require a token. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function generateToken(): string {
  return randomBytes(CSRF_TOKEN_BYTES).toString("hex");
}

/** Constant-time string comparison that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Ensures a CSRF token cookie exists on the response and exposes it on the
 * request as `req.csrfToken`. Mount this early (after `cookie-parser`) so every
 * client — including the very first request — receives a token to echo back.
 */
export function issueCsrfToken(req: Request, res: Response, next: NextFunction): void {
  let token = req.cookies?.[CSRF_COOKIE] as string | undefined;

  if (!token) {
    token = generateToken();
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false, // must be readable by first-party JS to echo in the header
      secure: isProduction(),
      sameSite: "strict",
      maxAge: CSRF_COOKIE_MAX_AGE,
    });
  }

  (req as Request & { csrfToken?: string }).csrfToken = token;
  next();
}

/**
 * Rejects state-mutating requests (POST/PUT/PATCH/DELETE) whose CSRF header does
 * not match the CSRF cookie. Safe methods and `Authorization: Bearer` requests
 * are allowed through.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  // Bearer-authenticated (stateless) requests are not CSRF-able: the browser
  // does not attach the Authorization header automatically.
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    next();
    return;
  }

  // CSRF only threatens requests that authenticate via an ambient session
  // cookie. Requests without one (unauthenticated, or authenticated via custom
  // headers such as wallet signatures) cannot be forged cross-site, so they are
  // not subject to the token check.
  const usesSessionCookie = SESSION_COOKIES.some((name) => Boolean(req.cookies?.[name]));
  if (!usesSessionCookie) {
    next();
    return;
  }

  const cookieToken = req.cookies?.[CSRF_COOKIE] as string | undefined;
  const headerValue = req.headers[CSRF_HEADER];
  const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
    res.status(403).json({
      error: "invalid_csrf_token",
      message: "Missing or invalid CSRF token",
      statusCode: 403,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  next();
}
