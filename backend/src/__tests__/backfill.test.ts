// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  runBackfill,
  type BackfillDefinition,
  type BackfillLogger,
  type BackfillStore,
} from "../services/backfill";

/** In-memory checkpoint store; mirrors the persistence a real store would do. */
class InMemoryStore<TCursor> implements BackfillStore<TCursor> {
  readonly saves: Array<{ cursor: TCursor; processed: number }> = [];

  constructor(private cursor: TCursor | null = null) {}

  async load(): Promise<TCursor | null> {
    return this.cursor;
  }

  async save(cursor: TCursor, processed: number): Promise<void> {
    this.saves.push({ cursor, processed });
    this.cursor = cursor;
  }
}

interface CapturedLog {
  message: string;
  meta?: Record<string, unknown>;
}

function makeLogger(logs: CapturedLog[]): BackfillLogger {
  return {
    info: (message, meta) => logs.push({ message, meta }),
    warn: () => {},
    error: () => {},
  };
}

interface Pipeline {
  definition: BackfillDefinition<string, string | null>;
  applied: string[];
  fetchCursors: Array<string | null>;
}

/**
 * Builds a pipeline over `batches`, where each batch's cursor is `cursor-<i>`.
 * `failOn` makes `processBatch` throw when it sees that item, simulating a
 * crash part-way through a run.
 */
function makePipeline(batches: string[][], failOn?: string): Pipeline {
  const applied: string[] = [];
  const fetchCursors: Array<string | null> = [];

  const definition: BackfillDefinition<string, string | null> = {
    name: "test-backfill",
    async fetchBatch(cursor) {
      fetchCursors.push(cursor);
      const index = cursor === null ? 0 : Number(cursor.replace("cursor-", "")) + 1;
      const items = batches[index] ?? [];
      return { items, cursor: `cursor-${index}`, done: index >= batches.length - 1 };
    },
    async processBatch(items) {
      if (failOn && items.includes(failOn)) {
        throw new Error(`boom on ${failOn}`);
      }
      applied.push(...items);
    },
  };

  return { definition, applied, fetchCursors };
}

describe("runBackfill", () => {
  it("processes every batch once and checkpoints after each completed batch", async () => {
    const store = new InMemoryStore<string | null>();
    const { definition, applied } = makePipeline([["a1", "a2"], ["b1"], ["c1", "c2", "c3"]]);

    const summary = await runBackfill(definition, store, null, makeLogger([]));

    expect(applied).toEqual(["a1", "a2", "b1", "c1", "c2", "c3"]);
    expect(summary).toEqual({ resumed: false, batches: 3, processed: 6 });
    expect(store.saves.map((s) => s.cursor)).toEqual(["cursor-0", "cursor-1", "cursor-2"]);
    expect(store.saves.map((s) => s.processed)).toEqual([2, 3, 6]);
  });

  it("does not checkpoint a batch that crashed mid-apply", async () => {
    const store = new InMemoryStore<string | null>();
    const { definition, applied } = makePipeline([["a1"], ["b1"], ["c1"]], "c1");

    await expect(runBackfill(definition, store, null, makeLogger([]))).rejects.toThrow("boom on c1");

    // Batches 0 and 1 completed; the failed batch 2 was never checkpointed.
    expect(applied).toEqual(["a1", "b1"]);
    expect(store.saves.map((s) => s.cursor)).toEqual(["cursor-0", "cursor-1"]);
  });

  it("resumes from the last completed batch's cursor instead of the start", async () => {
    const store = new InMemoryStore<string | null>();

    // First run crashes while applying the third batch.
    const crashed = makePipeline([["a1"], ["b1"], ["c1"]], "c1");
    await expect(runBackfill(crashed.definition, store, null, makeLogger([]))).rejects.toThrow();

    // Second run picks up from the checkpoint left by the first.
    const resumed = makePipeline([["a1"], ["b1"], ["c1"]]);
    const summary = await runBackfill(resumed.definition, store, "cursor-should-be-ignored", makeLogger([]));

    // The fetcher is asked to continue from the saved cursor, not from null.
    expect(resumed.fetchCursors[0]).toBe("cursor-1");
    // Only the unprocessed batch is replayed.
    expect(resumed.applied).toEqual(["c1"]);
    expect(summary).toEqual({ resumed: true, batches: 1, processed: 1 });
  });

  it("reports an estimate of the batches remaining in progress logs", async () => {
    const store = new InMemoryStore<string | null>();
    const logs: CapturedLog[] = [];
    const { definition } = makePipeline([["a1"], ["b1"], ["c1"]]);
    definition.estimateTotalBatches = () => 4;

    await runBackfill(definition, store, null, makeLogger(logs));

    const batchLogs = logs.filter((l) => l.message.endsWith("batch completed"));
    expect(batchLogs.map((l) => l.meta?.batchesRemaining)).toEqual([3, 2, 1]);
    expect(batchLogs.every((l) => l.meta?.estimatedTotalBatches === 4)).toBe(true);
  });

  it("omits the batches-remaining estimate when the total is unknown", async () => {
    const store = new InMemoryStore<string | null>();
    const logs: CapturedLog[] = [];
    const { definition } = makePipeline([["a1"], ["b1"]]);

    await runBackfill(definition, store, null, makeLogger(logs));

    const batchLogs = logs.filter((l) => l.message.endsWith("batch completed"));
    expect(batchLogs.map((l) => l.meta?.batchesRemaining)).toEqual([undefined, undefined]);
  });
});
