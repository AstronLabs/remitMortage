// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  createMemorySlowQueryStore,
  createPrismaSlowQueryStore,
  createSlowQueryEntry,
  createSlowQueryLoggingExtension,
  DEFAULT_SLOW_QUERY_THRESHOLD_MS,
  fingerprintQuery,
  getSlowQueryThresholdMs,
  isIgnoredModel,
  normalizeQuery,
  type SlowQueryRecord,
} from "../services/slowQueryLog";

const FIXED_NOW = new Date("2026-09-25T10:00:00.000Z");

function record(overrides: Partial<SlowQueryRecord> = {}): SlowQueryRecord {
  return {
    query: "AuditLog.findMany",
    fingerprint: "fp-audit",
    model: "AuditLog",
    operation: "findMany",
    durationMs: 250,
    occurredAt: FIXED_NOW,
    ...overrides,
  };
}

describe("getSlowQueryThresholdMs", () => {
  it("defaults when unset", () => {
    expect(getSlowQueryThresholdMs({})).toBe(DEFAULT_SLOW_QUERY_THRESHOLD_MS);
  });

  it("honours a configured value", () => {
    expect(getSlowQueryThresholdMs({ SLOW_QUERY_THRESHOLD_MS: "750" })).toBe(750);
  });

  it("falls back on malformed or non-positive values", () => {
    expect(getSlowQueryThresholdMs({ SLOW_QUERY_THRESHOLD_MS: "fast" })).toBe(
      DEFAULT_SLOW_QUERY_THRESHOLD_MS
    );
    expect(getSlowQueryThresholdMs({ SLOW_QUERY_THRESHOLD_MS: "0" })).toBe(
      DEFAULT_SLOW_QUERY_THRESHOLD_MS
    );
    expect(getSlowQueryThresholdMs({ SLOW_QUERY_THRESHOLD_MS: "-10" })).toBe(
      DEFAULT_SLOW_QUERY_THRESHOLD_MS
    );
  });
});

describe("normalizeQuery", () => {
  it("replaces literals with placeholders so equivalent queries group together", () => {
    expect(normalizeQuery("SELECT * FROM loan WHERE id = 42")).toBe(
      "SELECT * FROM loan WHERE id = ?"
    );
    expect(normalizeQuery("SELECT * FROM loan WHERE id = 43")).toBe(
      "SELECT * FROM loan WHERE id = ?"
    );
    expect(normalizeQuery("SELECT * FROM loan WHERE name = 'Alice'")).toBe(
      "SELECT * FROM loan WHERE name = ?"
    );
  });

  it("collapses IN lists and whitespace", () => {
    expect(normalizeQuery("SELECT * FROM t WHERE id IN (1, 2, 3)")).toBe(
      "SELECT * FROM t WHERE id IN (?)"
    );
    expect(normalizeQuery("SELECT\n   *\n  FROM t ;")).toBe("SELECT * FROM t");
  });

  it("is stable for already-normalized input", () => {
    const once = normalizeQuery("SELECT * FROM t WHERE id = 7");
    expect(normalizeQuery(once)).toBe(once);
  });
});

describe("fingerprintQuery", () => {
  it("is identical for equivalent statements and unique per pattern", () => {
    const a = fingerprintQuery("SELECT * FROM t WHERE id = 1");
    const b = fingerprintQuery("SELECT * FROM t WHERE id = 2");
    const c = fingerprintQuery("SELECT * FROM t WHERE account = 2");

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("createSlowQueryEntry", () => {
  it("returns null when the operation is within budget", () => {
    expect(
      createSlowQueryEntry({ query: "AuditLog.findMany", durationMs: 50, thresholdMs: 200 })
    ).toBeNull();
  });

  it("captures operations at or above the threshold", () => {
    const entry = createSlowQueryEntry({
      query: "AuditLog.findMany",
      durationMs: 249.6,
      thresholdMs: 200,
      model: "AuditLog",
      operation: "findMany",
      occurredAt: FIXED_NOW,
    });

    expect(entry).not.toBeNull();
    expect(entry).toMatchObject({
      query: "AuditLog.findMany",
      model: "AuditLog",
      operation: "findMany",
      durationMs: 250,
      occurredAt: FIXED_NOW,
    });
    expect(entry?.fingerprint).toBe(fingerprintQuery("AuditLog.findMany"));
  });

  it("rejects an empty pattern", () => {
    expect(
      createSlowQueryEntry({ query: "   ", durationMs: 999, thresholdMs: 1 })
    ).toBeNull();
  });
});

describe("isIgnoredModel", () => {
  it("only ignores the slow-query log model itself", () => {
    expect(isIgnoredModel("SlowQueryLog")).toBe(true);
    expect(isIgnoredModel("AuditLog")).toBe(false);
    expect(isIgnoredModel(null)).toBe(false);
  });
});

describe("slow query stores", () => {
  it("memory store records and filters by window", async () => {
    const store = createMemorySlowQueryStore();
    await store.record(record({ occurredAt: new Date("2026-09-01T00:00:00Z") }));
    await store.record(record({ fingerprint: "fp-b", occurredAt: new Date("2026-09-20T00:00:00Z") }));

    const found = await store.findSince(new Date("2026-09-10T00:00:00Z"));
    expect(found).toHaveLength(1);
    expect(found[0].fingerprint).toBe("fp-b");

    expect(await store.findSince(new Date("2026-09-01T00:00:00Z"), new Date("2026-09-15T00:00:00Z"))).toHaveLength(1);
    store.clear();
    expect(await store.findSince(new Date(0))).toHaveLength(0);
  });

  it("prisma store writes records and reads the window", async () => {
    const create = jest.fn().mockResolvedValue({});
    const findMany = jest.fn().mockResolvedValue([record()]);
    const prisma = { slowQueryLog: { create, findMany } };
    const store = createPrismaSlowQueryStore(prisma as never);

    await store.record(record());
    expect(create).toHaveBeenCalledWith({ data: record() });

    const since = new Date("2026-09-18T00:00:00Z");
    const until = new Date("2026-09-25T00:00:00Z");
    await store.findSince(since, until);
    expect(findMany).toHaveBeenCalledWith({
      where: { occurredAt: { gte: since, lt: until } },
      orderBy: { occurredAt: "asc" },
    });
  });
});

describe("createSlowQueryLoggingExtension", () => {
  type AllOps = (input: {
    model?: string;
    operation: string;
    args: unknown;
    query: (args: unknown) => Promise<unknown>;
  }) => Promise<unknown>;

  function handlerFor(extension: ReturnType<typeof createSlowQueryLoggingExtension>): AllOps {
    return (extension.query as { $allModels: { $allOperations: AllOps } }).$allModels
      .$allOperations;
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("captures operations that exceed the threshold and passes the result through", async () => {
    const captured: SlowQueryRecord[] = [];
    const extension = createSlowQueryLoggingExtension({
      thresholdMs: 1,
      now: () => FIXED_NOW,
      onSlowQuery: (entry) => captured.push(entry),
    });

    const result = await handlerFor(extension)({
      model: "AuditLog",
      operation: "findMany",
      args: {},
      query: async () => {
        await sleep(15);
        return ["row"];
      },
    });

    expect(result).toEqual(["row"]);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      query: "AuditLog.findMany",
      model: "AuditLog",
      operation: "findMany",
      occurredAt: FIXED_NOW,
    });
    expect(captured[0].durationMs).toBeGreaterThanOrEqual(1);
  });

  it("does not capture operations within budget", async () => {
    const captured: SlowQueryRecord[] = [];
    const extension = createSlowQueryLoggingExtension({
      thresholdMs: 10_000,
      onSlowQuery: (entry) => captured.push(entry),
    });

    await handlerFor(extension)({
      model: "Borrower",
      operation: "findUnique",
      args: {},
      query: async () => null,
    });

    expect(captured).toHaveLength(0);
  });

  it("never logs the slow-query log model, preventing recursion", async () => {
    const captured: SlowQueryRecord[] = [];
    const extension = createSlowQueryLoggingExtension({
      thresholdMs: 0,
      onSlowQuery: (entry) => captured.push(entry),
    });

    await handlerFor(extension)({
      model: "SlowQueryLog",
      operation: "create",
      args: {},
      query: async () => {
        await sleep(10);
        return {};
      },
    });

    expect(captured).toHaveLength(0);
  });
});
