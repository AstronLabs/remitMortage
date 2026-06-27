import { Keypair, nativeToScVal, Address } from "@stellar/stellar-sdk";
import {
  SorobanEventListener,
  computeBackoff,
  classifyTopic,
  decodeEvent,
  EventBatch,
  NormalizedEvent,
  DEFAULT_MAX_BACKOFF_MS,
} from "../services/eventListener";
import { InMemoryBalanceRepository } from "../services/balanceStore";

const BORROWER = Keypair.random().publicKey();

function event(
  topic: string,
  borrower: string | null,
  amount: string | null,
  ledger = 100
): NormalizedEvent {
  return { contractId: "C_ESCROW", topic, borrower, amount, ledger };
}

function batch(events: NormalizedEvent[], cursor = "cursor-1"): EventBatch {
  return { events, cursor, latestLedger: 1000 };
}

/** Collects log lines so assertions can confirm events are logged. */
function makeLogger() {
  const lines: string[] = [];
  return {
    lines,
    info: (m: string) => lines.push(m),
    warn: (m: string) => lines.push(m),
    error: (m: string) => lines.push(m),
  };
}

// ── Backoff ─────────────────────────────────────────────────────────────────

describe("computeBackoff", () => {
  it("doubles from 1s and caps at 30s (1s, 2s, 4s, 8s, ... 30s)", () => {
    expect(computeBackoff(0)).toBe(1000);
    expect(computeBackoff(1)).toBe(2000);
    expect(computeBackoff(2)).toBe(4000);
    expect(computeBackoff(3)).toBe(8000);
    expect(computeBackoff(4)).toBe(16000);
    // 2^5 * 1000 = 32000 -> capped
    expect(computeBackoff(5)).toBe(DEFAULT_MAX_BACKOFF_MS);
    expect(computeBackoff(50)).toBe(DEFAULT_MAX_BACKOFF_MS);
  });
});

// ── Topic classification ──────────────────────────────────────────────────────

describe("classifyTopic", () => {
  it("recognizes escrow and lending-pool topics", () => {
    expect(classifyTopic("deposit")).toBe("deposit");
    expect(classifyTopic("withdraw")).toBe("withdraw");
    expect(classifyTopic("release")).toBe("release");
    expect(classifyTopic("disburse")).toBe("disburse");
    expect(classifyTopic("repay")).toBe("repay");
  });

  it("ignores unrelated topics", () => {
    expect(classifyTopic("transfer")).toBeNull();
    expect(classifyTopic("")).toBeNull();
  });
});

// ── Event decoding (XDR ScVals) ───────────────────────────────────────────────

describe("decodeEvent", () => {
  it("parses topic symbol, borrower address, and i128 amount from ScVals", () => {
    const raw = {
      contractId: "C_ESCROW",
      topic: [
        nativeToScVal("deposit", { type: "symbol" }),
        new Address(BORROWER).toScVal(),
      ],
      value: nativeToScVal(5000n, { type: "i128" }),
      ledger: 42,
    };

    const decoded = decodeEvent(raw);

    expect(decoded.topic).toBe("deposit");
    expect(decoded.borrower).toBe(BORROWER);
    expect(decoded.amount).toBe("5000");
    expect(decoded.ledger).toBe(42);
  });

  it("parses borrower/amount from a map-shaped event value", () => {
    const raw = {
      contractId: "C_POOL",
      topic: [nativeToScVal("disburse", { type: "symbol" })],
      value: nativeToScVal(
        { borrower: new Address(BORROWER), amount: 250n },
        { type: { borrower: ["symbol", "address"], amount: ["symbol", "i128"] } }
      ),
      ledger: 7,
    };

    const decoded = decodeEvent(raw);

    expect(decoded.topic).toBe("disburse");
    expect(decoded.borrower).toBe(BORROWER);
    expect(decoded.amount).toBe("250");
  });
});

// ── Listener: capturing + syncing mock events ─────────────────────────────────

describe("SorobanEventListener — event capture & sync", () => {
  it("captures, parses, logs, and syncs a batch of mock events", async () => {
    const repository = new InMemoryBalanceRepository();
    const logger = makeLogger();

    const events = [
      event("deposit", BORROWER, "1000", 10),
      event("deposit", BORROWER, "500", 11),
      event("withdraw", BORROWER, "200", 12),
      event("disburse", BORROWER, "7000", 13),
      event("repay", BORROWER, "1000", 14),
      event("transfer", BORROWER, "999", 15), // unrelated -> ignored
    ];

    const listener = new SorobanEventListener({
      repository,
      logger,
      sleep: async () => {},
      fetcher: async (): Promise<EventBatch> => {
        // Deliver one batch, then stop the loop.
        listener.stop();
        return batch(events);
      },
    });

    listener.start();
    await listener.waitForStop();

    const balance = repository.get(BORROWER);
    expect(balance).not.toBeNull();
    // escrow: +1000 +500 -200 = 1300
    expect(balance!.escrowBalance).toBe("1300");
    // loan: +7000 -1000 = 6000
    expect(balance!.loanOutstanding).toBe("6000");
    expect(balance!.lastEventLedger).toBe(14);

    // The recognized events were logged; the unrelated one was not.
    expect(logger.lines.some((l) => l.includes("deposit amount=1000"))).toBe(true);
    expect(logger.lines.some((l) => l.includes("disburse amount=7000"))).toBe(true);
    expect(logger.lines.some((l) => l.includes("transfer"))).toBe(false);
  });

  it("skips recognized events that are missing a borrower or amount", async () => {
    const repository = new InMemoryBalanceRepository();
    const logger = makeLogger();

    const listener = new SorobanEventListener({
      repository,
      logger,
      sleep: async () => {},
      fetcher: async (): Promise<EventBatch> => {
        listener.stop();
        return batch([event("deposit", null, "1000")]);
      },
    });

    listener.start();
    await listener.waitForStop();

    expect(repository.list()).toHaveLength(0);
    expect(logger.lines.some((l) => l.includes("missing borrower/amount"))).toBe(true);
  });
});

// ── Listener: resiliency / reconnection ───────────────────────────────────────

describe("SorobanEventListener — resiliency", () => {
  it("does not crash on connection failures and backs off exponentially", async () => {
    const logger = makeLogger();
    const delays: number[] = [];

    const listener = new SorobanEventListener({
      logger,
      repository: new InMemoryBalanceRepository(),
      // record each delay; stop after 5 failed attempts
      sleep: async (ms: number) => {
        delays.push(ms);
        if (delays.length >= 5) listener.stop();
      },
      fetcher: async () => {
        throw new Error("RPC node dropped the connection");
      },
    });

    // The loop must never throw out of the process.
    listener.start();
    await expect(listener.waitForStop()).resolves.toBeUndefined();

    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  it("resets the backoff after a successful poll", async () => {
    const logger = makeLogger();
    const delays: number[] = [];
    let call = 0;

    const listener = new SorobanEventListener({
      logger,
      repository: new InMemoryBalanceRepository(),
      pollIntervalMs: 10,
      sleep: async (ms: number) => {
        delays.push(ms);
        if (delays.length >= 4) listener.stop();
      },
      fetcher: async (): Promise<EventBatch> => {
        call += 1;
        if (call === 1) throw new Error("fail #1"); // backoff 1000
        if (call === 2) throw new Error("fail #2"); // backoff 2000
        if (call === 3) return batch([]); // success -> poll interval, reset
        throw new Error("fail #3"); // backoff resets to 1000
      },
    });

    listener.start();
    await listener.waitForStop();

    expect(delays[0]).toBe(1000);
    expect(delays[1]).toBe(2000);
    expect(delays[2]).toBe(10); // poll interval after success
    expect(delays[3]).toBe(1000); // backoff reset
  });
});
