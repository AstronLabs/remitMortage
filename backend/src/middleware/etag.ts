// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Strong ETag / conditional GET support for read-heavy endpoints (issue #983).
 *
 * The tag is a SHA-256 of the exact JSON body the handler is about to send, so
 * it changes whenever the underlying data changes. User-scoped endpoints mix
 * the authenticated wallet into the hash as well, which guarantees two users
 * can never receive the same tag for a user-specific response.
 */

import { createHash } from "crypto";
import type { Request, Response, NextFunction } from "express";

export interface StrongEtagOptions {
  /**
   * Mix `req.user.walletAddress` into the hash. Use this for any response
   * whose body can differ per caller, so one user can never validate another
   * user's tag.
   */
  userScoped?: boolean;
}

function requestScope(req: Request, userScoped: boolean): string | undefined {
  if (!userScoped) return undefined;
  const user = (req as Request & { user?: { walletAddress?: string } }).user;
  return `user:${user?.walletAddress ?? "anonymous"}`;
}

/** Builds a quoted, strong ETag (never the `W/` weak form). */
export function computeStrongEtag(body: unknown, scope?: string): string {
  const serialized = typeof body === "string" ? body : JSON.stringify(body);
  const hash = createHash("sha256");
  if (scope) hash.update(scope);
  hash.update("\n");
  hash.update(serialized ?? "");
  return `"${hash.digest("base64url")}"`;
}

/**
 * If-None-Match uses weak comparison, so accept both our strong tag and an
 * equivalent `W/"..."` value from a client/proxy. `*` matches any resource.
 */
export function ifNoneMatchMatches(
  header: string | string[] | undefined,
  etag: string
): boolean {
  if (!header) return false;
  const raw = Array.isArray(header) ? header.join(",") : header;

  return raw.split(",").some((candidate) => {
    const value = candidate.trim();
    if (!value) return false;
    if (value === "*") return true;
    return (value.startsWith("W/") ? value.slice(2) : value) === etag;
  });
}

/**
 * Express middleware that replaces `res.json` with a wrapper computing a
 * strong ETag from the outgoing body. A matching `If-None-Match` short-circuits
 * to `304 Not Modified` with no body; the tag is still returned so clients can
 * keep revalidating.
 */
export function strongEtag(options: StrongEtagOptions = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const originalJson = res.json.bind(res);

    res.json = (body: any): Response => {
      const cacheable = res.statusCode >= 200 && res.statusCode < 300;
      if (!cacheable) {
        return originalJson(body);
      }

      if (options.userScoped) {
        // Shared caches must not serve one user's response to another.
        res.vary("Authorization");
        res.vary("Cookie");
      }

      const etag = computeStrongEtag(body, requestScope(req, Boolean(options.userScoped)));
      res.setHeader("ETag", etag);

      if (ifNoneMatchMatches(req.headers["if-none-match"], etag)) {
        res.status(304);
        res.removeHeader("Content-Type");
        res.removeHeader("Content-Length");
        res.end();
        return res;
      }

      return originalJson(body);
    };

    next();
  };
}
