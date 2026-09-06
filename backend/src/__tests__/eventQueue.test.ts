import {
  enqueueLedgerEvent,
  processNextEvent,
  drainDlq,
  getQueueDepth,
  getDlqDepth,
  type LedgerEventJob,
} from "../services/eventProducer.js";

// ── Mocks ────────────────────────────────────────────────────────────────

const mockRedisClient = {
  lpush: jest.fn(),
  brpop: jest.fn(),
  rpush: jest.fn(),
  llen: jest.fn(),
  get: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn(),
  del: jest.fn(),
  quit: jest.fn(),
  ping: jest.fn(),
};

jest.mock("../services/redis.js", () => ({
  getRedisClient: jest.fn(() => mockRedisClient),
}));

// ── Helpers ──────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<LedgerEventJob> = {}): LedgerEventJob {
  return {
    id: "job-001",
    topic: "deposit",
    borrower: "GABC…DEF",
    amount: "1000",
    ledger: 12345,
    contractId: "CC…",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockRedisClient.llen.mockResolvedValue(0);
  mockRedisClient.brpop.mockResolvedValue(null);
  mockRedisClient.get.mockResolvedValue(null);
});

describe("enqueueLedgerEvent", () => {
  it("should push a serialised job onto the Redis queue", async () => {
    mockRedisClient.lpush.mockResolvedValue(1);
    const job = makeJob();
    const ok = await enqueueLedgerEvent(job);
    expect(ok).toBe(true);
    expect(mockRedisClient.lpush).toHaveBeenCalledWith(
      "queue:ledger-events",
      JSON.stringify(job)
    );
  });

  it("should return false when Redis is unavailable", async () => {
    const { getRedisClient } = require("../services/redis.js");
    (getRedisClient as jest.Mock).mockReturnValueOnce(null);
    const ok = await enqueueLedgerEvent(makeJob());
    expect(ok).toBe(false);
  });

  it("should return false on redis error", async () => {
    mockRedisClient.lpush.mockRejectedValue(new Error("connection lost"));
    const ok = await enqueueLedgerEvent(makeJob());
    expect(ok).toBe(false);
  });
});

describe("processNextEvent", () => {
  it("should call the handler with the parsed job and return true", async () => {
    const job = makeJob();
    mockRedisClient.brpop.mockResolvedValue(["queue:ledger-events", JSON.stringify(job)]);
    mockRedisClient.del.mockResolvedValue(1);

    const handler = jest.fn().mockResolvedValue(undefined);
    const processed = await processNextEvent(handler);

    expect(processed).toBe(true);
    expect(handler).toHaveBeenCalledWith(job);
    expect(mockRedisClient.del).toHaveBeenCalledWith("queue:ledger-events:attempt:job-001");
  });

  it("should return false when the queue is empty", async () => {
    mockRedisClient.brpop.mockResolvedValue(null);
    const handler = jest.fn();
    const processed = await processNextEvent(handler);
    expect(processed).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("should retry on handler failure and re-enqueue the job", async () => {
    const job = makeJob();
    mockRedisClient.brpop.mockResolvedValue(["queue:ledger-events", JSON.stringify(job)]);
    mockRedisClient.get.mockResolvedValue("0"); // 0 previous attempts
    mockRedisClient.incr.mockResolvedValue(1);
    mockRedisClient.expire.mockResolvedValue(1);
    mockRedisClient.rpush.mockResolvedValue(1);

    const handler = jest.fn().mockRejectedValue(new Error("processing error"));

    const processed = await processNextEvent(handler);
    expect(processed).toBe(true);
    // Should be re-enqueued for retry
    expect(mockRedisClient.rpush).toHaveBeenCalledWith(
      "queue:ledger-events",
      JSON.stringify(job)
    );
  });

  it("should move job to DLQ after max retries", async () => {
    const job = makeJob();
    mockRedisClient.brpop.mockResolvedValue(["queue:ledger-events", JSON.stringify(job)]);
    mockRedisClient.get.mockResolvedValue("2"); // 2 previous attempts → this is 3rd → DLQ
    mockRedisClient.incr.mockResolvedValue(3);
    mockRedisClient.expire.mockResolvedValue(1);
    mockRedisClient.lpush.mockResolvedValue(1); // DLQ push

    const handler = jest.fn().mockRejectedValue(new Error("still failing"));
    const processed = await processNextEvent(handler);
    expect(processed).toBe(true);
    // Should go to DLQ, not re-enqueue
    expect(mockRedisClient.lpush).toHaveBeenCalledWith(
      "queue:ledger-events:dlq",
      expect.stringContaining("still failing")
    );
  });

  it("should handle malformed JSON by sending to DLQ", async () => {
    mockRedisClient.brpop.mockResolvedValue(["queue:ledger-events", "not-json"]);
    mockRedisClient.lpush.mockResolvedValue(1);

    const handler = jest.fn();
    const processed = await processNextEvent(handler);
    expect(processed).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(mockRedisClient.lpush).toHaveBeenCalledWith(
      "queue:ledger-events:dlq",
      expect.stringContaining("parse_error")
    );
  });
});

describe("queue depth diagnostics", () => {
  it("should return queue depth from llen", async () => {
    mockRedisClient.llen.mockResolvedValue(5);
    expect(await getQueueDepth()).toBe(5);
  });

  it("should return DLQ depth", async () => {
    // dlq llen uses a different key; our mock returns 5 for all
    mockRedisClient.llen.mockResolvedValue(3);
    expect(await getDlqDepth()).toBe(3);
  });
});

describe("drainDlq", () => {
  it("should pop all entries from the DLQ", async () => {
    const dlqEntry = JSON.stringify({
      payload: JSON.stringify(makeJob()),
      reason: "max_retries: timeout",
      failedAt: "2025-01-01T00:00:00.000Z",
    });
    mockRedisClient.brpop
      .mockResolvedValueOnce(["queue:ledger-events:dlq", dlqEntry])
      .mockResolvedValueOnce(["queue:ledger-events:dlq", dlqEntry])
      .mockResolvedValue(null); // queue empty

    const entries = await drainDlq();
    expect(entries).toHaveLength(2);
    expect(entries[0].reason).toBe("max_retries: timeout");
  });
});
