// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Browser-side prototype-pollution guards (issue #885).
 *
 * The invariant under test is the same as on the server: after an untrusted
 * payload has been through the helper, a freshly created `{}` must not have
 * gained a key.
 */

import {
  POLLUTION_KEYS,
  isPollutionKey,
  safeAssign,
  safeMerge,
  safeParseJson,
  sanitizeDeep,
} from "../safe-object";

const PAYLOADS: Array<{ name: string; json: string; probe: string }> = [
  { name: "top-level __proto__", json: '{"__proto__":{"polluted":"yes"}}', probe: "polluted" },
  {
    name: "nested __proto__",
    json: '{"outer":{"__proto__":{"nestedPolluted":"yes"}}}',
    probe: "nestedPolluted",
  },
  {
    name: "constructor.prototype",
    json: '{"constructor":{"prototype":{"ctorPolluted":"yes"}}}',
    probe: "ctorPolluted",
  },
  {
    name: "array element",
    json: '{"list":[{"__proto__":{"arrayPolluted":"yes"}}]}',
    probe: "arrayPolluted",
  },
];

afterEach(() => {
  for (const { probe } of PAYLOADS) {
    delete (Object.prototype as unknown as Record<string, unknown>)[probe];
  }
});

describe("isPollutionKey", () => {
  it("recognises exactly the three reserved keys", () => {
    for (const key of POLLUTION_KEYS) expect(isPollutionKey(key)).toBe(true);
    expect(isPollutionKey("proto")).toBe(false);
    expect(isPollutionKey("amount")).toBe(false);
  });
});

describe("safeParseJson", () => {
  it.each(PAYLOADS)("neutralises a $name payload", ({ json, probe }) => {
    const parsed = safeParseJson<Record<string, unknown>>(json);

    expect(Object.getOwnPropertyNames(parsed)).not.toContain("__proto__");
    expect(({} as Record<string, unknown>)[probe]).toBeUndefined();
  });

  it("keeps legitimate fields", () => {
    const parsed = safeParseJson<{ type: string; message: { body: string } }>(
      '{"type":"message","message":{"body":"hi"},"__proto__":{"x":1}}'
    );

    expect(parsed.type).toBe("message");
    expect(parsed.message.body).toBe("hi");
  });

  it("throws on malformed JSON", () => {
    expect(() => safeParseJson("{oops")).toThrow(SyntaxError);
  });
});

describe("sanitizeDeep", () => {
  it("strips reserved keys in place and returns the same reference", () => {
    const value = JSON.parse('{"keep":1,"__proto__":{"polluted":"yes"}}');

    expect(sanitizeDeep(value)).toBe(value);
    expect(value.keep).toBe(1);
    expect(Object.getOwnPropertyNames(value)).toEqual(["keep"]);
  });
});

describe("safeAssign / safeMerge", () => {
  it("safeAssign copies own keys but no reserved one", () => {
    const target: Record<string, unknown> = {};
    safeAssign(target, JSON.parse('{"__proto__":{"polluted":"yes"},"theme":"dark"}'));

    expect(target).toEqual({ theme: "dark" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("safeMerge folds nested objects without reaching a prototype", () => {
    const state: Record<string, unknown> = { filters: { status: "open", page: 1 } };

    safeMerge(
      state,
      JSON.parse('{"filters":{"page":2},"__proto__":{"polluted":"yes"},"sort":"desc"}')
    );

    expect(state).toEqual({ filters: { status: "open", page: 2 }, sort: "desc" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("ignores null and undefined sources", () => {
    expect(safeMerge({ a: 1 } as Record<string, unknown>, null, undefined)).toEqual({ a: 1 });
  });
});
