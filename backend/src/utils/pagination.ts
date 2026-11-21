// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Cursor ("keyset") pagination shared by list endpoints (issue #993).
 *
 * Page numbers and offsets duplicate rows when records are inserted between
 * requests and force the database to scan everything before an offset. Cursors
 * instead encode the stable `(sortKey, id)` position of the last row returned,
 * so the next page resumes strictly after it. The token is opaque to callers;
 * because it is signed into the query as a tuple, a tampered token cannot
 * silently skip or repeat rows.
 */

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export class InvalidPaginationError extends Error {
  readonly code: "invalid_limit" | "invalid_cursor";
  readonly field: "limit" | "cursor";

  constructor(field: "limit" | "cursor", message: string) {
    super(message);
    this.name = "InvalidPaginationError";
    this.field = field;
    this.code = field === "limit" ? "invalid_limit" : "invalid_cursor";
  }
}

export interface PageQuery {
  /** Effective page size, never above {@link MAX_PAGE_LIMIT}. */
  limit: number;
  /** Raw opaque cursor supplied by the caller, or null for the first page. */
  cursor: string | null;
}

export interface PagePagination {
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface Page<T> {
  data: T[];
  pagination: PagePagination;
}

export interface CursorPosition {
  /** Value of the stable sort key (a timestamp for the lists in this repo). */
  at: Date;
  /** Tie-breaker, so rows sharing a timestamp still page deterministically. */
  id: string;
}

/** Encode a position as an opaque, URL-safe token. */
export function encodeCursor(at: Date | string, id: string): string {
  const date = at instanceof Date ? at : new Date(at);
  return Buffer.from(JSON.stringify({ at: date.toISOString(), id })).toString("base64url");
}

/**
 * Decode a cursor, rejecting anything that is not a well-formed
 * `{ at: ISO timestamp, id: string }` token. Callers turn the thrown
 * {@link InvalidPaginationError} into a 400 response.
 */
export function decodeCursor(cursor: string | null | undefined): CursorPosition | null {
  if (cursor === null || cursor === undefined || cursor === "") return null;

  if (typeof cursor !== "string") {
    throw new InvalidPaginationError("cursor", "cursor must be a string");
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      at?: unknown;
      id?: unknown;
    };
    if (typeof parsed?.at !== "string" || typeof parsed?.id !== "string" || !parsed.id) {
      throw new Error("bad shape");
    }
    const at = new Date(parsed.at);
    if (Number.isNaN(at.getTime())) throw new Error("bad timestamp");
    return { at, id: parsed.id };
  } catch {
    throw new InvalidPaginationError("cursor", "cursor is invalid or tampered");
  }
}

/**
 * Parse `?limit` and `?cursor` into a normalised page query.
 *
 * `limit` defaults to {@link DEFAULT_PAGE_LIMIT} and is capped at
 * {@link MAX_PAGE_LIMIT}; non-integers and values below 1 are rejected rather
 * than silently coerced, so a broken client sees a 400.
 */
export function parsePageQuery(query: Record<string, unknown>): PageQuery {
  const rawLimit = query.limit;
  let limit = DEFAULT_PAGE_LIMIT;

  if (rawLimit !== undefined && rawLimit !== null && rawLimit !== "") {
    if (Array.isArray(rawLimit)) {
      throw new InvalidPaginationError("limit", "limit must be a single positive integer");
    }
    const parsed = typeof rawLimit === "number" ? rawLimit : Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new InvalidPaginationError("limit", "limit must be a positive integer");
    }
    limit = Math.min(parsed, MAX_PAGE_LIMIT);
  }

  const rawCursor = query.cursor;
  if (Array.isArray(rawCursor)) {
    throw new InvalidPaginationError("cursor", "cursor must be a single string");
  }
  const cursor =
    rawCursor === undefined || rawCursor === null || rawCursor === ""
      ? null
      : String(rawCursor);

  return { limit, cursor };
}

/**
 * Prisma `where` fragment that resumes strictly after `cursor` for a
 * descending `(sortField, id)` order. Returns `undefined` for the first page.
 */
export function cursorWhere(
  cursor: CursorPosition | null,
  sortField: string
): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  return {
    OR: [
      { [sortField]: { lt: cursor.at } },
      { [sortField]: cursor.at, id: { lt: cursor.id } },
    ],
  };
}

/**
 * Build a page from rows fetched with `take: limit + 1`. The extra row is
 * used only to detect whether a next page exists.
 */
export function buildPage<T>(rows: T[], limit: number, cursorOf: (row: T) => string): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && data.length > 0 ? cursorOf(data[data.length - 1]) : null;

  return {
    data,
    pagination: {
      limit,
      cursor: null,
      nextCursor,
      hasMore,
    },
  };
}
