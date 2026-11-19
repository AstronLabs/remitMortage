// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  cleanupPublishedOutboxEvents,
  enqueueOutboxEvent,
  publishPendingOutboxEvents,
  type OutboxDb,
  type OutboxRow,
  type OutboxPublisher,
} from "../services/transactionalOutbox.js";

/**
 * In-memory stand-in for the Prisma outbox slice. It models the two
 * properties the tests care about: a unique `idempotencyKey` throws the
 * Prisma `P2002` code, and only rows with `publishedAt === null` are returned
 * to the relay.
 */
class FakeOutboxDb implements OutboxDb {
  rows: OutboxRow[] = [];
  private nextId = 1n;

  outboxEvent = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const key = String(data.idempotencyKey);
      if (this.rows.some((row) => row.idempotencyKey === key)) {
        const error = new Error("Unique constraint failed") as Error & { code: string };
        error.code = "P2002";
        throw error;
      }
      const row: OutboxRow = {
        id: this.nextId++,
        idempotencyKey: key,
        topic: String(data.topic),
        payload: data.payload,
        occurredAt: data.occurredAt as Date,
        createdAt: new Date(),
        publishedAt: null,
        attempts: 0,
        lastError: null,
      };
      this.rows.push(row);
      return row;
    },

    findMany: async ({
      take,
    }: {
      where: Record<string, unknown>;
      orderBy: Record<string, unknown>;
      take: number;
    }) => this.rows.filter((row) => row.publishedAt === null).slice(0, take),

    update: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const row = this.rows.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error("row not found");
      if (typeof data.lastError === "string") row.lastError = data.lastError;
      const increment = data.attempts as { increment?: number } | undefined;
      if (increment?.increment) row.attempts += increment.increment;
      return row;
    },

    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const row = this.rows.find(
        (candidate) => candidate.id === where.id && candidate.publishedAt === null
      );
      if (!row) return { count: 0 };
      row.publishedAt = data.publishedAt as Date;
      if (data.lastError === null) row.lastError = null;
      return { count: 1 };
    },

    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const publishedAt = where.publishedAt as { lt?: Date } | undefined;
      const cutoff = publishedAt?.lt;
      const before = this.rows.length;
      this.rows = this.rows.filter(
        (row) => !(row.publishedAt && cutoff && row.publishedAt < cutoff)
      );
      return { count: before - this.rows.length };
    },
  };
}

function makeDb(): FakeOutboxDb {
  return new FakeOutboxDb();
}

describe("transactional outbox", () => {
  it("writes an event as pending in the caller's transaction", async () => {
    const db = makeDb();
    await enqueueOutboxEvent(db, {
      idempotencyKey: "loan.approved:1",
      topic: "loan.approved",
      payload: { loanId: "1" },
    });

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].publishedAt).toBeNull();
    expect(db.rows[0].topic).toBe("loan.approved");
  });

  it("ignores a duplicate idempotency key instead of creating a second event", async () => {
    const db = makeDb();
    const event = {
      idempotencyKey: "loan.approved:1",
      topic: "loan.approved",
      payload: { loanId: "1" },
    };

    await enqueueOutboxEvent(db, event);
    await expect(enqueueOutboxEvent(db, event)).resolves.toBeUndefined();

    expect(db.rows).toHaveLength(1);
  });

  it("does not lose an event when the process dies between commit and publish", async () => {
    const db = makeDb();
    // Producer commits the business change + outbox row, then the process
    // "dies" before any relay/publish happens.
    await enqueueOutboxEvent(db, {
      idempotencyKey: "loan.approved:42",
      topic: "loan.approved",
      payload: { loanId: "42" },
    });
    expect(db.rows[0].publishedAt).toBeNull();

    // New process / next scheduler tick: the relay finds the committed row.
    const delivered: string[] = [];
    const publisher: OutboxPublisher = async (event) => {
      delivered.push(event.idempotencyKey);
    };
    const result = await publishPendingOutboxEvents(publisher, { db });

    expect(result).toEqual({ published: 1, failed: 0, scanned: 1 });
    expect(delivered).toEqual(["loan.approved:42"]);
    expect(db.rows[0].publishedAt).not.toBeNull();
  });

  it("leaves a failed publish pending and retries it on the next pass", async () => {
    const db = makeDb();
    await enqueueOutboxEvent(db, {
      idempotencyKey: "deposit:7",
      topic: "deposit",
      payload: {},
    });

    const failing: OutboxPublisher = async () => {
      throw new Error("queue unavailable");
    };
    const first = await publishPendingOutboxEvents(failing, { db });
    expect(first).toEqual({ published: 0, failed: 1, scanned: 1 });
    expect(db.rows[0].publishedAt).toBeNull();
    expect(db.rows[0].attempts).toBe(1);
    expect(db.rows[0].lastError).toContain("queue unavailable");

    const delivered: string[] = [];
    const second = await publishPendingOutboxEvents(
      async (event) => delivered.push(event.idempotencyKey),
      { db }
    );
    expect(second).toEqual({ published: 1, failed: 0, scanned: 1 });
    expect(delivered).toEqual(["deposit:7"]);
    expect(db.rows[0].publishedAt).not.toBeNull();
  });

  it("passes the idempotency key to the publisher so consumers can deduplicate", async () => {
    const db = makeDb();
    await enqueueOutboxEvent(db, {
      idempotencyKey: "stable-key-123",
      topic: "loan.repaid",
      payload: { amount: "100" },
    });

    const seen: Array<{ key: string; topic: string }> = [];
    await publishPendingOutboxEvents(
      async (event) => {
        seen.push({ key: event.idempotencyKey, topic: event.topic });
      },
      { db }
    );

    expect(seen).toEqual([{ key: "stable-key-123", topic: "loan.repaid" }]);
  });

  it("honours the batch size so one pass cannot run unbounded", async () => {
    const db = makeDb();
    for (let i = 0; i < 5; i += 1) {
      await enqueueOutboxEvent(db, {
        idempotencyKey: `event:${i}`,
        topic: "tick",
        payload: { i },
      });
    }

    const result = await publishPendingOutboxEvents(async () => undefined, {
      db,
      batchSize: 2,
    });
    expect(result.scanned).toBe(2);
    expect(db.rows.filter((row) => row.publishedAt !== null)).toHaveLength(2);
  });

  it("deletes only published rows older than the retention window", async () => {
    const db = makeDb();
    const now = new Date("2026-10-17T12:00:00Z");
    const old = new Date("2026-10-01T12:00:00Z");
    const recent = new Date("2026-10-17T11:00:00Z");

    db.rows.push(
      {
        id: 1n,
        idempotencyKey: "old-published",
        topic: "t",
        payload: {},
        occurredAt: old,
        createdAt: old,
        publishedAt: old,
        attempts: 0,
        lastError: null,
      },
      {
        id: 2n,
        idempotencyKey: "recent-published",
        topic: "t",
        payload: {},
        occurredAt: recent,
        createdAt: recent,
        publishedAt: recent,
        attempts: 0,
        lastError: null,
      },
      {
        id: 3n,
        idempotencyKey: "old-but-pending",
        topic: "t",
        payload: {},
        occurredAt: old,
        createdAt: old,
        publishedAt: null,
        attempts: 0,
        lastError: null,
      }
    );

    const result = await cleanupPublishedOutboxEvents({
      db,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      now: () => now,
    });

    expect(result.deleted).toBe(1);
    expect(db.rows.map((row) => row.idempotencyKey)).toEqual([
      "recent-published",
      "old-but-pending",
    ]);
  });
});
