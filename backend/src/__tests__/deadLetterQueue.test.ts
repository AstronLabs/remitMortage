// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Dead-letter queue for background jobs (issue #1103).
 *
 * Drives the capture path through a worker-shaped event emitter firing
 * BullMQ's `failed` event once per attempt, then lists and requeues through
 * the real admin routes against an in-memory `DeadLetterJob` table.
 */

import { EventEmitter } from "events";

jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// In-memory stand-in for prisma.deadLetterJob.
type Row = Record<string, any>;
const mockRows: Row[] = [];
let mockNextId = 1;

function matches(row: Row, where: Record<string, unknown> = {}) {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

jest.mock("../services/db.js", () => ({
  prisma: {
    deadLetterJob: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row: Row = {
          id: `dlq-${mockNextId++}`,
          failedAt: new Date(Date.now() + mockNextId),
          requeuedAt: null,
          requeuedBy: null,
          requeuedJobId: null,
          ...data,
        };
        mockRows.push(row);
        return { ...row };
      }),
      findMany: jest.fn(async ({ where, take }: { where: Row; take: number }) =>
        mockRows
          .filter((row) => matches(row, where))
          .sort((a, b) => b.failedAt.getTime() - a.failedAt.getTime())
          .slice(0, take)
          .map((row) => ({ ...row }))
      ),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = mockRows.find((r) => r.id === where.id);
        return row ? { ...row } : null;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const hit = mockRows.filter((row) => matches(row, where));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      }),
    },
  },
}));

jest.mock("../middleware/auth.js", () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    if (req.headers.authorization !== "Bearer admin") {
      return res.status(401).json({ error: "missing_authorization" });
    }
    req.user = { walletAddress: "GADMINWALLET", network: "testnet" };
    return next();
  },
}));

// The router module imports the real queue service; keep it inert here.
jest.mock("../services/queueService.js", () => ({
  queueService: { getQueueByName: jest.fn(() => undefined) },
}));

import express from "express";
import request from "supertest";
import {
  attachDeadLetterQueue,
  captureExhaustedJob,
  hasExhaustedRetries,
  requeueDeadLetterJob,
  DeadLetterJobStateError,
  type RequeueTarget,
} from "../services/deadLetterQueue.js";
import { createAdminDeadLetterRouter } from "../routes/adminDeadLetter.js";

const QUEUE = "remitmortgage-notifications";

/** Minimal BullMQ-shaped queue recording what was enqueued. */
function fakeQueue() {
  const added: Array<{ name: string; data: unknown }> = [];
  const queue: RequeueTarget = {
    add: jest.fn(async (name: string, data: unknown) => {
      added.push({ name, data });
      return { id: `job-${added.length + 100}` };
    }),
  };
  return { queue, added };
}

/** Simulates BullMQ running a job until it either succeeds or runs out of attempts. */
async function runWithRetries(
  worker: EventEmitter,
  job: { id: string; name: string; data: unknown; opts: { attempts: number }; attemptsMade: number },
  handler: (data: unknown) => Promise<void>
) {
  while (job.attemptsMade < job.opts.attempts) {
    try {
      await handler(job.data);
      return "completed";
    } catch (err) {
      job.attemptsMade += 1;
      worker.emit("failed", job, err);
    }
  }
  return "failed";
}

/** Lets fire-and-forget capture writes settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function buildApp(resolve: (name: string) => RequeueTarget | undefined) {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", createAdminDeadLetterRouter(resolve));
  return app;
}

beforeEach(() => {
  mockRows.length = 0;
  mockNextId = 1;
});

describe("hasExhaustedRetries", () => {
  it("is false while attempts remain and true once they are used up", () => {
    expect(hasExhaustedRetries({ attemptsMade: 1, opts: { attempts: 3 } } as any)).toBe(false);
    expect(hasExhaustedRetries({ attemptsMade: 3, opts: { attempts: 3 } } as any)).toBe(true);
    // No configured attempts means a single attempt.
    expect(hasExhaustedRetries({ attemptsMade: 1, opts: {} } as any)).toBe(true);
  });
});

describe("capturing a job that exhausts its retries", () => {
  it("moves the job to the dead-letter queue with its payload and last failure reason", async () => {
    const worker = new EventEmitter();
    attachDeadLetterQueue(QUEUE, worker as any);

    const payload = { notificationId: "n-1", recipient: "ops@example.com", type: "EMAIL", content: "hello" };
    let attempt = 0;
    const outcome = await runWithRetries(
      worker,
      { id: "42", name: "send-notification", data: payload, opts: { attempts: 3 }, attemptsMade: 0 },
      async () => {
        attempt += 1;
        throw new Error(`SMTP timeout #${attempt}`);
      }
    );
    await flush();

    expect(outcome).toBe("failed");
    // Earlier failed attempts still had retries left, so only one record exists.
    expect(mockRows).toHaveLength(1);
    expect(mockRows[0]).toMatchObject({
      queueName: QUEUE,
      jobName: "send-notification",
      originalJobId: "42",
      payload,
      failureReason: "SMTP timeout #3",
      attemptsMade: 3,
      status: "dead",
    });
  });

  it("does not dead-letter a job that succeeds on a retry", async () => {
    const worker = new EventEmitter();
    attachDeadLetterQueue(QUEUE, worker as any);

    let attempt = 0;
    const outcome = await runWithRetries(
      worker,
      { id: "43", name: "send-notification", data: { n: 1 }, opts: { attempts: 3 }, attemptsMade: 0 },
      async () => {
        attempt += 1;
        if (attempt < 3) throw new Error("flaky");
      }
    );
    await flush();

    expect(outcome).toBe("completed");
    expect(mockRows).toHaveLength(0);
  });

  it("never throws when the dead-letter write itself fails", async () => {
    const store = {
      create: jest.fn().mockRejectedValue(new Error("db down")),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    };
    await expect(
      captureExhaustedJob(QUEUE, { id: "1", name: "x", data: {}, attemptsMade: 1, opts: {} } as any, new Error("boom"), store)
    ).resolves.toBeNull();
  });
});

describe("admin dead-letter endpoints", () => {
  async function seedDeadJob(payload: unknown = { notificationId: "n-9", nested: { amount: "10.50", tags: ["a"] } }) {
    return captureExhaustedJob(
      QUEUE,
      { id: "77", name: "send-notification", data: payload, attemptsMade: 5, opts: { attempts: 5 } } as any,
      new Error("provider returned 503")
    );
  }

  it("requires admin auth", async () => {
    const app = buildApp(() => undefined);
    expect((await request(app).get("/api/admin/dead-letter-jobs")).status).toBe(401);
    expect((await request(app).post("/api/admin/dead-letter-jobs/x/requeue")).status).toBe(401);
  });

  it("lists dead-lettered jobs with their payload and failure reason", async () => {
    await seedDeadJob();
    const app = buildApp(() => undefined);

    const res = await request(app).get("/api/admin/dead-letter-jobs").set("Authorization", "Bearer admin");

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.jobs[0]).toMatchObject({
      queueName: QUEUE,
      jobName: "send-notification",
      failureReason: "provider returned 503",
      payload: { notificationId: "n-9", nested: { amount: "10.50", tags: ["a"] } },
      status: "dead",
    });
  });

  it("rejects an unknown status filter", async () => {
    const app = buildApp(() => undefined);
    const res = await request(app)
      .get("/api/admin/dead-letter-jobs?status=bogus")
      .set("Authorization", "Bearer admin");
    expect(res.status).toBe(400);
  });

  it("requeues a job onto its original queue with its payload intact", async () => {
    const payload = { notificationId: "n-9", nested: { amount: "10.50", tags: ["a"] } };
    const record = await seedDeadJob(payload);
    const { queue, added } = fakeQueue();
    const app = buildApp((name) => (name === QUEUE ? queue : undefined));

    const res = await request(app)
      .post(`/api/admin/dead-letter-jobs/${record!.id}/requeue`)
      .set("Authorization", "Bearer admin");

    expect(res.status).toBe(200);
    expect(res.body.job).toMatchObject({ status: "requeued", requeuedBy: "GADMINWALLET", requeuedJobId: "job-101" });
    expect(added).toEqual([{ name: "send-notification", data: payload }]);

    // The requeued job runs with exactly the payload that originally failed.
    let ranWith: unknown;
    const worker = new EventEmitter();
    attachDeadLetterQueue(QUEUE, worker as any);
    const outcome = await runWithRetries(
      worker,
      { id: "job-101", name: added[0].name, data: added[0].data, opts: { attempts: 5 }, attemptsMade: 0 },
      async (data) => {
        ranWith = data;
      }
    );
    expect(outcome).toBe("completed");
    expect(ranWith).toEqual(payload);

    // It drops out of the default (awaiting-requeue) listing.
    const list = await request(app).get("/api/admin/dead-letter-jobs").set("Authorization", "Bearer admin");
    expect(list.body.count).toBe(0);
    const requeued = await request(app)
      .get("/api/admin/dead-letter-jobs?status=requeued")
      .set("Authorization", "Bearer admin");
    expect(requeued.body.count).toBe(1);
  });

  it("refuses to requeue the same job twice", async () => {
    const record = await seedDeadJob();
    const { queue, added } = fakeQueue();
    const app = buildApp(() => queue);

    await request(app).post(`/api/admin/dead-letter-jobs/${record!.id}/requeue`).set("Authorization", "Bearer admin");
    const again = await request(app)
      .post(`/api/admin/dead-letter-jobs/${record!.id}/requeue`)
      .set("Authorization", "Bearer admin");

    expect(again.status).toBe(409);
    expect(added).toHaveLength(1);
  });

  it("returns 404 for an unknown id and 503 when the queue is unavailable", async () => {
    const record = await seedDeadJob();
    const app = buildApp(() => undefined);

    const missing = await request(app)
      .post("/api/admin/dead-letter-jobs/nope/requeue")
      .set("Authorization", "Bearer admin");
    expect(missing.status).toBe(404);

    const unavailable = await request(app)
      .post(`/api/admin/dead-letter-jobs/${record!.id}/requeue`)
      .set("Authorization", "Bearer admin");
    expect(unavailable.status).toBe(503);
    // Still dead-lettered, so it can be requeued once the queue is back.
    expect(mockRows[0].status).toBe("dead");
  });

  it("releases the claim when enqueueing fails so the job can be retried", async () => {
    const record = await seedDeadJob();
    const failing: RequeueTarget = { add: jest.fn().mockRejectedValue(new Error("redis down")) };

    await expect(requeueDeadLetterJob(record!.id, { resolveQueue: () => failing })).rejects.toThrow("redis down");
    expect(mockRows[0]).toMatchObject({ status: "dead", requeuedAt: null });

    const { queue } = fakeQueue();
    await expect(requeueDeadLetterJob(record!.id, { resolveQueue: () => queue })).resolves.toMatchObject({
      status: "requeued",
    });
    await expect(requeueDeadLetterJob(record!.id, { resolveQueue: () => queue })).rejects.toBeInstanceOf(
      DeadLetterJobStateError
    );
  });
});
