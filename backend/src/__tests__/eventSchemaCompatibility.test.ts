// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Contract event schema compatibility.
 *
 * The indexer decodes Soroban contract events positionally, so a renamed,
 * removed or reordered event field can silently break ingestion after a
 * contract change. This suite:
 *   1. compares the events published by the Rust contracts with the golden
 *      fixtures in contracts/event-schemas/ and fails on any drift,
 *   2. proves the drift detector catches renamed / removed / reordered fields,
 *   3. emits every fixture event as XDR and decodes it with the indexer parser.
 *
 * To change an event on purpose see docs/EVENT_SCHEMA_COMPATIBILITY.md.
 */

import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { decodeEvent, classifyTopic } from "../services/eventListener";

// eventListener.ts pulls in services/audit.js -> services/db.js (real Prisma
// client) for its default `logAudit`; stub it to keep this suite DB-free.
jest.mock("../services/db.js", () => ({
  prisma: { auditLog: { create: jest.fn() } },
}));

// The schema tooling is plain CommonJS shared with the contracts CLI.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const schema = require("../../../contracts/event-schemas/schema.cjs");

interface Shape {
  topicArgs: string[];
  dataKind: "tuple" | "value";
  data: string[];
}
interface Fixture {
  contract: string;
  schemaVersion: number;
  changes: { version: number; summary: string }[];
  events: Record<string, Shape[]>;
}

const fixtures: Record<string, Fixture> = schema.loadFixtures();
const current: Record<string, Record<string, Shape[]>> = schema.extractAll();

const publish = (topics: string, data: string) => `env.events().publish(${topics}, ${data});`;

describe("golden event schema fixtures", () => {
  it("has a fixture for every contract that emits events, and no orphans", () => {
    expect(Object.keys(fixtures).sort()).toEqual(Object.keys(current).sort());
  });

  it("covers every event the contracts currently emit", () => {
    const total = Object.values(current).reduce((n, ev) => n + Object.keys(ev).length, 0);
    expect(total).toBeGreaterThan(0);
  });

  describe.each(Object.keys(current))("%s", (contract) => {
    it("matches the events in the contract source", () => {
      const { breaking, additive } = schema.diffEvents(fixtures[contract].events, current[contract]);
      const hint =
        "\nIf the change is intentional run `node contracts/event-schemas/schema.cjs update " +
        '[--breaking "<reason>"]` and commit the fixture (docs/EVENT_SCHEMA_COMPATIBILITY.md).';
      expect({ breaking, additive, hint: breaking.length || additive.length ? hint : "" }).toEqual({
        breaking: [],
        additive: [],
        hint: "",
      });
    });

    it("records every schemaVersion bump in its change log", () => {
      expect(schema.versionProblems(fixtures[contract])).toEqual([]);
    });
  });
});

describe("breaking change detection", () => {
  const baseline = schema.extractFromSource(
    publish(
      '(symbol_short!("deposit"), goal_id.clone())',
      "(borrower.clone(), amount, record.deposited)",
    ),
  );
  const toEvents = (src: string) => {
    const events: Record<string, Shape[]> = {};
    for (const ev of schema.extractFromSource(src)) {
      (events[schema.eventKey(ev)] ??= []).push({ topicArgs: ev.topicArgs, dataKind: ev.dataKind, data: ev.data });
    }
    return events;
  };
  const golden = toEvents(
    publish('(symbol_short!("deposit"), goal_id.clone())', "(borrower.clone(), amount, record.deposited)"),
  );

  it("parses the baseline event", () => {
    expect(baseline).toHaveLength(1);
    expect(baseline[0]).toMatchObject({ name: "deposit", topicArgs: ["goal_id"], data: ["borrower", "amount", "deposited"] });
  });

  it("is clean when nothing changed (clone/path noise is ignored)", () => {
    const same = toEvents(publish('(symbol_short!("deposit"), goal_id)', "(borrower, amount, record.deposited)"));
    expect(schema.diffEvents(golden, same)).toEqual({ breaking: [], additive: [] });
  });

  it("fails when an event field is renamed", () => {
    const renamed = toEvents(publish('(symbol_short!("deposit"), goal_id)', "(borrower, value, record.deposited)"));
    expect(schema.diffEvents(golden, renamed).breaking).toHaveLength(1);
  });

  it("fails when an event field is removed", () => {
    const removed = toEvents(publish('(symbol_short!("deposit"), goal_id)', "(borrower, amount)"));
    expect(schema.diffEvents(golden, removed).breaking).toHaveLength(1);
  });

  it("fails when event fields are reordered", () => {
    const reordered = toEvents(publish('(symbol_short!("deposit"), goal_id)', "(amount, borrower, record.deposited)"));
    expect(schema.diffEvents(golden, reordered).breaking).toHaveLength(1);
  });

  it("fails when a topic argument is removed", () => {
    const fewerTopics = toEvents(publish('(symbol_short!("deposit"),)', "(borrower, amount, record.deposited)"));
    expect(schema.diffEvents(golden, fewerTopics).breaking).toHaveLength(1);
  });

  it("fails when the event itself is removed or renamed", () => {
    const renamed = toEvents(publish('(symbol_short!("dep"), goal_id)', "(borrower, amount, record.deposited)"));
    const { breaking, additive } = schema.diffEvents(golden, renamed);
    expect(breaking).toHaveLength(1);
    expect(additive).toHaveLength(1);
  });

  it("treats a brand-new event as additive, not breaking", () => {
    const added = toEvents(
      publish('(symbol_short!("deposit"), goal_id)', "(borrower, amount, record.deposited)") +
        publish('(symbol_short!("fresh"),)', "(x,)"),
    );
    const { breaking, additive } = schema.diffEvents(golden, added);
    expect(breaking).toEqual([]);
    expect(additive).toHaveLength(1);
  });

  it("ignores events published only from #[cfg(test)] modules and comments", () => {
    const events = schema.extractFromSource(`
      // env.events().publish((symbol_short!("commented"),), (a,));
      #[cfg(test)]
      mod tests { fn t() { env.events().publish((symbol_short!("testonly"),), (a,)); } }
    `);
    expect(events).toEqual([]);
  });

  describe("version bump requirement", () => {
    const fixture: Fixture = {
      contract: "demo",
      schemaVersion: 1,
      changes: [{ version: 1, summary: "Initial baseline" }],
      events: golden,
    };
    const renamedEvents = toEvents(publish('(symbol_short!("deposit"), goal_id)', "(borrower, value, record.deposited)"));

    it("refuses a breaking update without a recorded reason", () => {
      expect(() => schema.planUpdate({ demo: fixture }, { demo: renamedEvents })).toThrow(/breaking/i);
    });

    it("bumps schemaVersion and records the reason when one is given", () => {
      const next = schema.planUpdate({ demo: fixture }, { demo: renamedEvents }, "rename amount to value");
      expect(next.demo.schemaVersion).toBe(2);
      expect(next.demo.changes.at(-1)).toEqual({ version: 2, summary: "rename amount to value" });
      expect(schema.versionProblems(next.demo)).toEqual([]);
    });

    it("does not bump the version for additive changes", () => {
      const added = { ...golden, ...toEvents(publish('(symbol_short!("fresh"),)', "(x,)")) };
      expect(schema.planUpdate({ demo: fixture }, { demo: added }).demo.schemaVersion).toBe(1);
    });

    it("flags a schemaVersion that has no change-log entry", () => {
      expect(schema.versionProblems({ ...fixture, schemaVersion: 2 })).not.toEqual([]);
    });
  });
});

describe("event version tracking", () => {
  const emit = (version: number, data: string) =>
    `emit_event(env, ${version}, (symbol_short!("deposit"), goal_id), ${data});`;
  const toEvents = (src: string) => {
    const events: Record<string, (Shape & { version?: number })[]> = {};
    for (const ev of schema.extractFromSource(src)) {
      (events[schema.eventKey(ev)] ??= []).push({
        topicArgs: ev.topicArgs,
        dataKind: ev.dataKind,
        data: ev.data,
        version: ev.version,
      });
    }
    return events;
  };
  const golden = toEvents(emit(1, "(borrower, amount)"));

  it("reads the version from emit_event and keeps it out of the topic args", () => {
    const [ev] = schema.extractFromSource(emit(1, "(borrower, amount)"));
    expect(ev).toMatchObject({ name: "deposit", version: 1, topicArgs: ["goal_id"], data: ["borrower", "amount"] });
  });

  it("is clean when neither payload nor version changed", () => {
    expect(schema.diffEvents(golden, toEvents(emit(1, "(borrower, amount)")))).toEqual({ breaking: [], additive: [] });
  });

  it("fails when the payload changes without bumping the version", () => {
    const { breaking } = schema.diffEvents(golden, toEvents(emit(1, "(borrower, amount, fee)")));
    expect(breaking).toHaveLength(1);
    expect(breaking[0]).toContain("without bumping its version");
  });

  it("reports a payload change that bumps the version as a recorded breaking change", () => {
    const { breaking } = schema.diffEvents(golden, toEvents(emit(2, "(borrower, amount, fee)")));
    expect(breaking).toHaveLength(1);
    expect(breaking[0]).not.toContain("without bumping its version");
  });
});

describe("indexer decodes every event the contracts emit", () => {
  const topicScVal = (value: string, literal: boolean) =>
    nativeToScVal(value, { type: literal ? "symbol" : "string" });

  /** Builds the raw Soroban RPC event a contract would emit for a fixture shape. */
  function emit(name: string, shape: Shape, ledger: number) {
    const [head, ...subTopics] = name.split("/");
    const literals = shape.topicArgs.filter((a) => a.startsWith('"')).length;
    expect(subTopics).toHaveLength(literals);

    let nextLiteral = 0;
    const topic: xdr.ScVal[] = [
      topicScVal(head, true),
      ...shape.topicArgs.map((arg) =>
        arg.startsWith('"') ? topicScVal(subTopics[nextLiteral++], true) : topicScVal(`arg-${arg}`, false),
      ),
    ];
    const value =
      shape.dataKind === "tuple"
        ? nativeToScVal(shape.data.map((_, i) => BigInt(i + 1)), { type: "i128" })
        : nativeToScVal(BigInt(7), { type: "i128" });
    return { contractId: "CONTRACT", topic, value, ledger };
  }

  const cases: [string, string, string, Shape][] = [];
  for (const [contract, events] of Object.entries(current)) {
    for (const [name, shapes] of Object.entries(events)) {
      shapes.forEach((shape) => cases.push([contract, name, describeShape(shape), shape]));
    }
  }

  function describeShape(shape: Shape): string {
    return `topics[${shape.topicArgs.join(",")}] data(${shape.dataKind})[${shape.data.join(",")}]`;
  }

  it.each(cases)("%s: %s %s", (_contract, name, _desc, shape) => {
    const raw = emit(name, shape, 4242);
    const decoded = decodeEvent(raw);

    expect(decoded.topic).toBe(name.split("/")[0]);
    expect(decoded.ledger).toBe(4242);
    expect(decoded.contractId).toBe("CONTRACT");
    // The indexer only acts on topics it classifies; everything else must be
    // ignored cleanly rather than throw.
    expect(() => classifyTopic(decoded.topic)).not.toThrow();
  });

  it("decodes a scalar data value into the amount field", () => {
    const decoded = decodeEvent({
      contractId: "C",
      topic: [nativeToScVal("deposit", { type: "symbol" })],
      value: nativeToScVal(BigInt(7), { type: "i128" }),
      ledger: 1,
    });
    expect(decoded.amount).toBe("7");
  });
});
