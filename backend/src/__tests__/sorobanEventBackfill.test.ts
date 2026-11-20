// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import type { EventBatch, EventFetcher, NormalizedEvent } from "../services/eventListener";
import type { BackfillLogger } from "../services/backfill";

// The script pulls in services/audit.js -> services/db.js (the real Prisma
// client). Stub the DB layer so these tests never touch a database.
jest.mock("../services/db.js", () => ({
  prisma: { auditLog: { create: jest.fn() } },
  disconnect: jest.fn(),
  loadIndexerState: jest.fn(),
  saveIndexerState: jest.fn(),
  recordEscrowDeposit: jest.fn(),
  recordEscrowWithdrawal: jest.fn(),
  recordLoanDisbursement: jest.fn(),
  recordLoanRepayment: jest.fn(),
}));

import {
  loadIndexerState,
  recordEscrowDeposit,
  saveIndexerState,
} from "../services/db.js";
import { parseArgs, runSorobanEventBackfill } from "../scripts/soroban-event-backfill.js";

const mockedLoad = loadIndexerState as jest.Mock;
const mockedSave = saveIndexerState as jest.Mock;
const mockedDeposit = recordEscrowDeposit as jest.Mock;

function deposit(ledger: number): NormalizedEvent {
  return { contractId: "C_ESCROW", topic: "deposit", borrower: "B1", amount: "100", ledger };
}

function batchOf(
  events: NormalizedEvent[],
  cursor: string | null,
  latestLedger: number
): EventBatch {
  return { events, cursor, latestLedger };
}

/** Sequential fetcher; records the cursor each call was made with. */
function makeFetcher(batches: EventBatch[]): {
  fetcher: EventFetcher;
  calls: Array<string | null>;
} {
  const calls: Array<string | null> = [];
  let index = 0;
  const fetcher: EventFetcher = async (cursor) => {
    calls.push(cursor);
    const batch = batches[index];
    index += 1;
    if (!batch) {
      throw new Error("fetcher exhausted");
    }
    return batch;
  };
  return { fetcher, calls };
}

function makeLogger(): BackfillLogger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedSave.mockResolvedValue(undefined);
  mockedDeposit.mockResolvedValue(undefined);
});

describe("runSorobanEventBackfill", () => {
  it("applies every event in range and checkpoints after each completed batch", async () => {
    mockedLoad.mockResolvedValue({ lastProcessedLedger: 0, cursor: null });
    const { fetcher } = makeFetcher([
      batchOf([deposit(100)], "cursor-1", 100),
      batchOf([deposit(101)], "cursor-2", 101),
    ]);

    const summary = await runSorobanEventBackfill(100, 101, { fetcher, logger: makeLogger() });

    expect(mockedDeposit).toHaveBeenCalledTimes(2);
    expect(mockedDeposit).toHaveBeenNthCalledWith(1, "B1", "C_ESCROW", "100", 100);
    expect(mockedDeposit).toHaveBeenNthCalledWith(2, "B1", "C_ESCROW", "100", 101);
    expect(mockedSave.mock.calls).toEqual([
      ["soroban_event_backfill", 100, "cursor-1"],
      ["soroban_event_backfill", 101, "cursor-2"],
    ]);
    expect(summary).toEqual({ resumed: false, batches: 2, processed: 2 });
  });

  it("does not checkpoint a batch that crashed mid-apply", async () => {
    mockedLoad.mockResolvedValue({ lastProcessedLedger: 0, cursor: null });
    mockedDeposit
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("rpc write failed"));
    const { fetcher } = makeFetcher([
      batchOf([deposit(100)], "cursor-1", 100),
      batchOf([deposit(101)], "cursor-2", 101),
    ]);

    await expect(
      runSorobanEventBackfill(100, 101, { fetcher, logger: makeLogger() })
    ).rejects.toThrow("rpc write failed");

    // Only the first, fully-applied batch was checkpointed.
    expect(mockedSave.mock.calls).toEqual([["soroban_event_backfill", 100, "cursor-1"]]);
  });

  it("resumes the interrupted run from the recorded cursor, not from the start", async () => {
    // Checkpoint left behind by the crashed run above.
    mockedLoad.mockResolvedValue({ lastProcessedLedger: 100, cursor: "cursor-1" });
    const { fetcher, calls } = makeFetcher([batchOf([deposit(101)], "cursor-2", 101)]);

    const summary = await runSorobanEventBackfill(100, 101, { fetcher, logger: makeLogger() });

    // The fetcher continues from the saved cursor rather than restarting.
    expect(calls[0]).toBe("cursor-1");
    // Ledger 100 is not replayed; only the unprocessed event is applied.
    expect(mockedDeposit).toHaveBeenCalledTimes(1);
    expect(mockedDeposit).toHaveBeenCalledWith("B1", "C_ESCROW", "100", 101);
    expect(summary).toMatchObject({ resumed: true, processed: 1 });
  });
});

describe("parseArgs", () => {
  it("validates the ledger range", () => {
    expect(parseArgs(["10", "20"])).toEqual({ startLedger: 10, endLedger: 20 });
    expect(() => parseArgs([undefined as unknown as string, "20"])).toThrow("start");
    expect(() => parseArgs(["0", "20"])).toThrow("Invalid start");
    expect(() => parseArgs(["30", "20"])).toThrow("less than or equal");
  });
});
