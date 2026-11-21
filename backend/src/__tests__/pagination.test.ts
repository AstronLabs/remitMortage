// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  InvalidPaginationError,
  buildPage,
  cursorWhere,
  decodeCursor,
  encodeCursor,
  parsePageQuery,
} from "../utils/pagination.js";

describe("cursor pagination (#993)", () => {
  it("round-trips an opaque (timestamp, id) cursor", () => {
    const at = new Date("2026-11-21T12:00:00.000Z");
    const cursor = encodeCursor(at, "loan-7");

    expect(decodeCursor(cursor)).toEqual({ at, id: "loan-7" });
  });

  it("rejects malformed and tampered cursors", () => {
    expect(() => decodeCursor("not-a-cursor")).toThrow(InvalidPaginationError);
    expect(() => decodeCursor(Buffer.from("{\"at\":\"nope\",\"id\":\"x\"}").toString("base64url"))).toThrow(
      InvalidPaginationError
    );
  });

  it("defaults and caps the page size", () => {
    expect(parsePageQuery({}).limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(parsePageQuery({ limit: "5" })).toEqual({ limit: 5, cursor: null });
    expect(parsePageQuery({ limit: "5000" }).limit).toBe(MAX_PAGE_LIMIT);
  });

  it("rejects a non-positive or non-integer limit", () => {
    expect(() => parsePageQuery({ limit: "0" })).toThrow(InvalidPaginationError);
    expect(() => parsePageQuery({ limit: "2.5" })).toThrow(InvalidPaginationError);
    expect(() => parsePageQuery({ limit: "abc" })).toThrow(InvalidPaginationError);
  });

  it("builds a next cursor only when an extra row was fetched", () => {
    const cursorOf = (row: { id: string }) => row.id;
    const full = buildPage([{ id: "a" }, { id: "b" }, { id: "c" }], 2, cursorOf);
    expect(full.data).toEqual([{ id: "a" }, { id: "b" }]);
    expect(full.pagination).toMatchObject({ hasMore: true, nextCursor: "b" });

    const last = buildPage([{ id: "a" }, { id: "b" }], 2, cursorOf);
    expect(last.pagination).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("resumes strictly after the cursor's timestamp and ties by id", () => {
    const at = new Date("2026-11-21T12:00:00.000Z");
    expect(cursorWhere({ at, id: "b" }, "createdAt")).toEqual({
      OR: [
        { createdAt: { lt: at } },
        { createdAt: at, id: { lt: "b" } },
      ],
    });
    expect(cursorWhere(null, "createdAt")).toBeUndefined();
  });
});
