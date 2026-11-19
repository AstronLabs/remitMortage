// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Prototype-pollution and unsafe-deserialization guards (issue #885).
 *
 * Every test here asserts the property that actually matters: after the
 * payload has been through the guard, **no prototype has changed**. A plain
 * `{}` created afterwards must not have picked up a key, and an unrelated
 * object must not have inherited one.
 *
 * Prototype freezing is covered separately in `prototypeFreeze.test.ts`,
 * because freezing is irreversible within a module registry.
 */

import express from "express";
import request from "supertest";

import {
  POLLUTION_KEYS,
  createSafeRecord,
  hasPollutionKey,
  isPollutionKey,
  safeAssign,
  safeMerge,
  safeParseJson,
  sanitizeDeep,
} from "../utils/safeObject";
import { prototypePollutionGuard } from "../middleware/prototypePollutionGuard";

jest.mock("../services/audit", () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { logAudit } = require("../services/audit") as { logAudit: jest.Mock };

/** The canonical payloads an attacker sends at a JSON API. */
const POLLUTION_PAYLOADS: Array<{ name: string; json: string; probe: string }> = [
  {
    name: "top-level __proto__",
    json: '{"__proto__":{"polluted":"yes"}}',
    probe: "polluted",
  },
  {
    name: "nested __proto__",
    json: '{"profile":{"__proto__":{"nestedPolluted":"yes"}}}',
    probe: "nestedPolluted",
  },
  {
    name: "constructor.prototype",
    json: '{"constructor":{"prototype":{"ctorPolluted":"yes"}}}',
    probe: "ctorPolluted",
  },
  {
    name: "__proto__ inside an array element",
    json: '{"items":[{"__proto__":{"arrayPolluted":"yes"}}]}',
    probe: "arrayPolluted",
  },
  {
    name: "bare prototype key",
    json: '{"prototype":{"protoKeyPolluted":"yes"}}',
    probe: "protoKeyPolluted",
  },
];

/** Reads a key off a fresh object — non-undefined means a prototype changed. */
function probePrototype(key: string): unknown {
  return (({} as Record<string, unknown>)[key]);
}

afterEach(() => {
  // Any test that does manage to pollute must not leak into the next one.
  for (const { probe } of POLLUTION_PAYLOADS) {
    delete (Object.prototype as unknown as Record<string, unknown>)[probe];
  }
  jest.clearAllMocks();
});

// ── Key classification ───────────────────────────────────────────────────

describe("isPollutionKey", () => {
  it("recognises exactly the three reserved keys", () => {
    for (const key of POLLUTION_KEYS) expect(isPollutionKey(key)).toBe(true);
    for (const key of ["proto", "__proto", "Constructor", "walletAddress", "amount"]) {
      expect(isPollutionKey(key)).toBe(false);
    }
  });
});

// ── safeParseJson ────────────────────────────────────────────────────────

describe("safeParseJson", () => {
  it.each(POLLUTION_PAYLOADS)("drops the reserved keys in a $name payload", ({ json, probe }) => {
    const parsed = safeParseJson<Record<string, unknown>>(json);

    expect(hasPollutionKey(parsed)).toBe(false);
    expect(Object.getOwnPropertyNames(parsed)).not.toContain("__proto__");
    expect(probePrototype(probe)).toBeUndefined();
  });

  it("keeps every legitimate field, at every depth", () => {
    const parsed = safeParseJson<{
      walletAddress: string;
      escrow: { deposited: string; goals: string[] };
    }>(
      '{"walletAddress":"GABC","escrow":{"deposited":"125.50","goals":["savings","build"]},"__proto__":{"x":1}}'
    );

    expect(parsed.walletAddress).toBe("GABC");
    expect(parsed.escrow.deposited).toBe("125.50");
    expect(parsed.escrow.goals).toEqual(["savings", "build"]);
  });

  it("still throws on malformed JSON, like JSON.parse", () => {
    expect(() => safeParseJson("{not json")).toThrow(SyntaxError);
  });

  it("round-trips scalars and arrays unchanged", () => {
    expect(safeParseJson("42")).toBe(42);
    expect(safeParseJson('"hello"')).toBe("hello");
    expect(safeParseJson("null")).toBeNull();
    expect(safeParseJson("[1,2,3]")).toEqual([1, 2, 3]);
  });
});

// ── sanitizeDeep ─────────────────────────────────────────────────────────

describe("sanitizeDeep", () => {
  it("strips reserved keys in place and reports their paths", () => {
    // Built via JSON.parse so `__proto__` is a real own data property, which
    // is exactly the shape a request body arrives in.
    const body = JSON.parse(
      '{"name":"ok","nested":{"__proto__":{"a":1},"keep":true},"list":[{"constructor":{"b":2}}]}'
    );

    const { value, stripped } = sanitizeDeep(body);

    expect(value).toBe(body); // same reference — middleware relies on this
    expect(stripped.sort()).toEqual(["list[0].constructor", "nested.__proto__"]);
    expect(body.name).toBe("ok");
    expect(body.nested.keep).toBe(true);
    expect(hasPollutionKey(body)).toBe(false);
  });

  it("reports nothing for a clean payload", () => {
    const { stripped } = sanitizeDeep({ amount: "10", goal: "savings", tags: ["a"] });
    expect(stripped).toEqual([]);
  });

  it("survives a cyclic object without recursing forever", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;

    expect(() => sanitizeDeep(cyclic)).not.toThrow();
  });

  it("leaves non-plain values alone", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    const payload = { when: date, bytes: Buffer.from("abc") };

    sanitizeDeep(payload);

    expect(payload.when).toBe(date);
    expect(payload.bytes.toString()).toBe("abc");
  });
});

// ── safeMerge / safeAssign ───────────────────────────────────────────────

describe("safeMerge", () => {
  it("cannot pollute a prototype even from an unsanitised source", () => {
    const untrusted = JSON.parse('{"__proto__":{"merged":"yes"},"label":"fine"}');
    const settings: Record<string, unknown> = { label: "old" };

    safeMerge(settings, untrusted);

    expect(settings.label).toBe("fine");
    expect(probePrototype("merged")).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(settings, "__proto__")).toBe(false);
  });

  it("cannot reach a prototype through constructor.prototype", () => {
    const untrusted = JSON.parse('{"constructor":{"prototype":{"ctorMerged":"yes"}}}');

    safeMerge({} as Record<string, unknown>, untrusted);

    expect(probePrototype("ctorMerged")).toBeUndefined();
    expect(({} as Record<string, unknown>).ctorMerged).toBeUndefined();
  });

  it("merges nested plain objects and replaces everything else", () => {
    const target: Record<string, unknown> = {
      escrow: { deposited: "100", target: "1000" },
      tags: ["a"],
    };

    safeMerge(target, { escrow: { deposited: "250" }, tags: ["b", "c"], extra: 1 });

    expect(target).toEqual({
      escrow: { deposited: "250", target: "1000" },
      tags: ["b", "c"],
      extra: 1,
    });
  });

  it("ignores null and undefined sources", () => {
    const target = { a: 1 };
    expect(safeMerge(target as Record<string, unknown>, null, undefined)).toEqual({ a: 1 });
  });

  it("does not trigger an inherited setter on the target", () => {
    // A setter that a previous (successful) pollution attack might have left
    // behind must not be reachable by a later merge.
    let setterCalls = 0;
    Object.defineProperty(Object.prototype, "trap", {
      configurable: true,
      set() {
        setterCalls += 1;
      },
      get() {
        return undefined;
      },
    });

    try {
      safeMerge({} as Record<string, unknown>, { trap: "value" });
      expect(setterCalls).toBe(0);
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>).trap;
    }
  });
});

describe("safeAssign", () => {
  it("copies own keys but never a reserved one", () => {
    const untrusted = JSON.parse('{"__proto__":{"assigned":"yes"},"goal":"savings"}');
    const target: Record<string, unknown> = {};

    safeAssign(target, untrusted);

    expect(target).toEqual({ goal: "savings" });
    expect(probePrototype("assigned")).toBeUndefined();
  });
});

describe("createSafeRecord", () => {
  it("returns a prototype-less map, so a user key cannot hit a builtin", () => {
    const record = createSafeRecord<number>({ a: 1 });

    expect(Object.getPrototypeOf(record)).toBeNull();
    expect(record.a).toBe(1);
    expect(record["toString"]).toBeUndefined();
  });

  it("drops reserved keys from its seed entries", () => {
    const record = createSafeRecord(JSON.parse('{"__proto__":{"x":1},"ok":2}'));
    expect(Object.getOwnPropertyNames(record)).toEqual(["ok"]);
  });
});

// ── Express middleware ───────────────────────────────────────────────────

function buildApp(mode: "strip" | "reject" = "strip") {
  const app = express();
  app.use(express.json());
  app.use(prototypePollutionGuard({ mode }));
  app.post("/echo", (req, res) => {
    res.json({ body: req.body, probes: {} });
  });
  app.get("/echo-query", (req, res) => {
    res.json({ query: req.query });
  });
  return app;
}

describe("prototypePollutionGuard", () => {
  it.each(POLLUTION_PAYLOADS)(
    "strips a $name body and leaves every prototype untouched",
    async ({ json, probe }) => {
      const res = await request(buildApp())
        .post("/echo")
        .set("Content-Type", "application/json")
        .send(json);

      expect(res.status).toBe(200);
      expect(hasPollutionKey(res.body.body)).toBe(false);
      expect(probePrototype(probe)).toBeUndefined();
      expect(({} as Record<string, unknown>)[probe]).toBeUndefined();
    }
  );

  it("passes a clean body through untouched and records nothing", async () => {
    const res = await request(buildApp())
      .post("/echo")
      .send({ amount: "100.50", goal: "savings", nested: { ok: true } });

    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({
      amount: "100.50",
      goal: "savings",
      nested: { ok: true },
    });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("records a stripped payload in the audit trail", async () => {
    await request(buildApp())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send('{"__proto__":{"polluted":"yes"},"amount":"1"}');

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "security.prototype_pollution.blocked",
        metadata: expect.objectContaining({
          mode: "strip",
          keys: ["body.__proto__"],
        }),
      })
    );
  });

  it("strips a reserved key from the query string", async () => {
    const res = await request(buildApp()).get(
      "/echo-query?__proto__[polluted]=yes&goal=savings"
    );

    expect(res.status).toBe(200);
    expect(hasPollutionKey(res.body.query)).toBe(false);
    expect(res.body.query.goal).toBe("savings");
    expect(probePrototype("polluted")).toBeUndefined();
  });

  it("answers 400 in reject mode without invoking the handler", async () => {
    const res = await request(buildApp("reject"))
      .post("/echo")
      .set("Content-Type", "application/json")
      .send('{"__proto__":{"polluted":"yes"}}');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unsafe_payload");
    expect(probePrototype("polluted")).toBeUndefined();
  });
});

// ── The attack this all prevents ─────────────────────────────────────────

describe("the unguarded sink, for contrast", () => {
  it("a naive deep merge of the same payload does pollute, which is why safeMerge exists", () => {
    function naiveMerge(target: Record<string, any>, source: Record<string, any>) {
      for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === "object") {
          naiveMerge((target[key] ??= {}), source[key]);
        } else {
          target[key] = source[key];
        }
      }
      return target;
    }

    const untrusted = JSON.parse('{"__proto__":{"naivePolluted":"yes"}}');
    naiveMerge({}, untrusted);

    // Demonstrates the vulnerability class...
    expect(({} as Record<string, unknown>).naivePolluted).toBe("yes");
    delete (Object.prototype as unknown as Record<string, unknown>).naivePolluted;

    // ...and that the sanctioned helper does not have it.
    safeMerge({} as Record<string, unknown>, JSON.parse('{"__proto__":{"naivePolluted":"yes"}}'));
    expect(({} as Record<string, unknown>).naivePolluted).toBeUndefined();
  });
});
