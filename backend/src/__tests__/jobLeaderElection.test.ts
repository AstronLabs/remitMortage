// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  advisoryLockKey,
  createJobLeaderElection,
  createPrismaAdvisoryLockBackend,
  createPrismaJobRunStore,
  resolveInstanceId,
  scheduledJob,
  type JobLeaderElection,
} from "../services/jobLeaderElection.js";
import { metricsRegistry } from "../services/metrics.js";
import { InMemoryJobRunStore, InMemoryLockManager } from "../test-utils/inMemoryAdvisoryLocks.js";

jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const JOB = "unit-test-job";

/** A tiny cluster of simulated instances sharing one database. */
function cluster(size: number, startMs = Date.parse("2026-10-17T00:00:00.000Z")) {
  let nowMs = startMs;
  const locks = new InMemoryLockManager();
  const runs = new InMemoryJobRunStore();
  const sessions = Array.from({ length: size }, (_, i) => locks.connect(`instance-${i + 1}`));
  const instances: JobLeaderElection[] = sessions.map((session) =>
    createJobLeaderElection({ backend: session, runs, instanceId: session.name, now: () => new Date(nowMs) })
  );
  return {
    locks,
    runs,
    sessions,
    instances,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function counter(name: string, labels: Record<string, string>): Promise<number> {
  const metric = (await metricsRegistry.getMetricsAsJSON()).find((m) => m.name === name) as any;
  const match = metric?.values?.find((v: any) =>
    Object.entries(labels).every(([k, val]) => v.labels[k] === val)
  );
  return match?.value ?? 0;
}

describe("advisoryLockKey", () => {
  it("is stable, distinct per job and fits a signed 64-bit integer", () => {
    expect(advisoryLockKey("a")).toBe(advisoryLockKey("a"));
    expect(advisoryLockKey("a")).not.toBe(advisoryLockKey("b"));
    const key = BigInt(advisoryLockKey("kyc-expiry"));
    expect(key >= -(2n ** 63n) && key < 2n ** 63n).toBe(true);
  });
});

describe("resolveInstanceId", () => {
  it("prefers INSTANCE_ID and otherwise generates a unique id", () => {
    expect(resolveInstanceId({ INSTANCE_ID: " web-3 " } as any)).toBe("web-3");
    expect(resolveInstanceId({} as any)).not.toBe(resolveInstanceId({} as any));
  });
});

describe("racing instances", () => {
  it("executes a scheduled run exactly once across many replicas", async () => {
    const { instances, runs } = cluster(12);
    const job = jest.fn(async () => {
      await tick();
      await tick();
      return "done";
    });

    const results = await Promise.all(instances.map((i) => i.run(JOB, job)));

    expect(job).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === "executed")).toHaveLength(1);
    const skipped = results.filter((r) => r.status === "skipped");
    expect(skipped).toHaveLength(11);
    // Whoever lost the race either saw the lock held or the finished run.
    expect(skipped.every((r) => r.status === "skipped" && ["lock_held", "recently_run"].includes(r.reason))).toBe(true);
    expect(runs.rows).toHaveLength(1);
  });

  it("records which instance ran the job", async () => {
    const { instances, runs } = cluster(5);
    const results = await Promise.all(instances.map((i) => i.run(JOB, async () => undefined)));
    const winnerIndex = results.findIndex((r) => r.status === "executed");

    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]).toMatchObject({
      jobName: JOB,
      instanceId: `instance-${winnerIndex + 1}`,
      status: "succeeded",
    });
    expect(runs.rows[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("skips with lock_held while the leader is still running", async () => {
    const { instances } = cluster(2);
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => (finish = resolve));

    const leader = instances[0].run(JOB, () => blocked);
    await tick();
    const follower = await instances[1].run(JOB, async () => "should not run");
    expect(follower).toEqual({ status: "skipped", reason: "lock_held" });

    finish();
    expect((await leader).status).toBe("executed");
  });

  it("skips a straggler whose tick lands just after the leader finished (recently_run)", async () => {
    const { instances, advance } = cluster(2);
    const job = jest.fn(async () => undefined);

    await instances[0].run(JOB, job);
    advance(400);
    const straggler = await instances[1].run(JOB, job);

    expect(straggler).toEqual({ status: "skipped", reason: "recently_run" });
    expect(job).toHaveBeenCalledTimes(1);
  });

  it("runs again on the next scheduled tick, possibly on a different instance", async () => {
    const { instances, runs, advance } = cluster(3);
    const job = jest.fn(async () => undefined);

    await instances[0].run(JOB, job, { minIntervalMs: 30_000 });
    advance(60_000);
    const next = await instances[2].run(JOB, job, { minIntervalMs: 30_000 });

    expect(next.status).toBe("executed");
    expect(job).toHaveBeenCalledTimes(2);
    expect(runs.rows.map((r) => r.instanceId)).toEqual(["instance-1", "instance-3"]);
  });

  it("keeps different jobs independent", async () => {
    const { instances } = cluster(2);
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => (finish = resolve));

    const a = instances[0].run("job-a", () => blocked);
    await tick();
    const b = await instances[1].run("job-b", async () => "ok");
    expect(b.status).toBe("executed");
    finish();
    await a;
  });
});

describe("holder crash", () => {
  it("releases the lock when the holder dies and the next run proceeds", async () => {
    const { instances, sessions, locks, runs, advance } = cluster(2);
    const hung = new Promise<void>(() => undefined); // the crashed process never finishes

    void instances[0].run(JOB, () => hung);
    await tick();
    expect(locks.isLocked(advisoryLockKey(JOB))).toBe(true);
    expect(runs.rows[0]).toMatchObject({ instanceId: "instance-1", status: "running" });

    locks.crash(sessions[0]);
    expect(locks.isLocked(advisoryLockKey(JOB))).toBe(false);

    advance(1_000); // inside the min-interval window: the dead run must not count
    const takeover = jest.fn(async () => "recovered");
    const result = await instances[1].run(JOB, takeover);

    expect(result.status).toBe("executed");
    expect(takeover).toHaveBeenCalledTimes(1);
    expect(runs.rows.map((r) => [r.instanceId, r.status])).toEqual([
      ["instance-1", "abandoned"],
      ["instance-2", "succeeded"],
    ]);
  });

  it("does not let a dead session acquire locks", async () => {
    const { sessions, locks } = cluster(1);
    locks.crash(sessions[0]);
    await expect(sessions[0].tryAcquire("1")).rejects.toThrow(/dead/);
  });
});

describe("failures", () => {
  it("records a failed run, releases the lock, rethrows, and counts the run as completed", async () => {
    const { instances, runs, locks, advance } = cluster(2);

    await expect(
      instances[0].run(JOB, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(locks.isLocked(advisoryLockKey(JOB))).toBe(false);
    expect(runs.rows[0]).toMatchObject({ status: "failed", error: "boom" });

    // Another replica's tick for the same run must not silently re-run it...
    advance(300);
    expect(await instances[1].run(JOB, async () => undefined)).toEqual({ status: "skipped", reason: "recently_run" });
    // ...but the next scheduled tick retries.
    advance(60_000);
    expect((await instances[1].run(JOB, async () => undefined)).status).toBe("executed");
  });
});

describe("metrics", () => {
  it("reports skipped runs by reason", async () => {
    const name = `metric-job-${Date.now()}`;
    const { instances, advance } = cluster(3);
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => (finish = resolve));

    const leader = instances[0].run(name, () => blocked);
    await tick();
    await instances[1].run(name, async () => undefined); // lock_held
    finish();
    await leader;
    advance(100);
    await instances[2].run(name, async () => undefined); // recently_run

    expect(await counter("remitmortgage_scheduled_job_skipped_total", { job: name, reason: "lock_held" })).toBe(1);
    expect(await counter("remitmortgage_scheduled_job_skipped_total", { job: name, reason: "recently_run" })).toBe(1);
    expect(await counter("remitmortgage_scheduled_job_runs_total", { job: name, outcome: "executed" })).toBe(1);
  });
});

describe("scheduledJob wrapper", () => {
  it("never rejects, and counts leadership errors separately from job failures", async () => {
    const name = `wrapper-job-${Date.now()}`;
    const failing = scheduledJob(name, async () => { throw new Error("job broke"); }, {}, cluster(1).instances[0]);
    await expect(failing()).resolves.toBeUndefined();
    expect(await counter("remitmortgage_scheduled_job_runs_total", { job: name, outcome: "failed" })).toBe(1);
    expect(await counter("remitmortgage_scheduled_job_runs_total", { job: name, outcome: "leadership_error" })).toBe(0);

    const broken: JobLeaderElection = { instanceId: "x", run: async () => { throw new Error("db down"); } };
    await expect(scheduledJob(name, async () => undefined, {}, broken)()).resolves.toBeUndefined();
    expect(await counter("remitmortgage_scheduled_job_runs_total", { job: name, outcome: "leadership_error" })).toBe(1);
  });

  it("runs the job on the leader only", async () => {
    const { instances } = cluster(4);
    const job = jest.fn(async () => { await tick(); });
    await Promise.all(instances.map((i) => scheduledJob(JOB, job, {}, i)()));
    expect(job).toHaveBeenCalledTimes(1);
  });
});

describe("PostgreSQL backend", () => {
  /** Fake Prisma whose $transaction stays open until the callback settles. */
  function fakePrisma(locked: boolean | "error") {
    const calls: { sql: string; params: unknown[] }[] = [];
    const state = { open: false, options: undefined as any, endTransaction: undefined as undefined | ((e?: Error) => void) };
    const prisma = {
      $transaction: jest.fn(async (fn: any, options: any) => {
        state.options = options;
        state.open = true;
        const tx = {
          $queryRaw: async (strings: TemplateStringsArray, ...params: unknown[]) => {
            calls.push({ sql: strings.join("?"), params });
            if (locked === "error") throw new Error("connection refused");
            return [{ locked }];
          },
        };
        try {
          return await Promise.race([
            fn(tx),
            new Promise((_, reject) => { state.endTransaction = reject; }),
          ]);
        } finally {
          state.open = false;
        }
      }),
    };
    return { prisma, calls, state };
  }

  it("takes a transaction-scoped try-lock and holds the transaction until released", async () => {
    const { prisma, calls, state } = fakePrisma(true);
    const handle = await createPrismaAdvisoryLockBackend(prisma as any).tryAcquire(advisoryLockKey(JOB), { maxHoldMs: 90_000 });

    expect(handle).not.toBeNull();
    expect(calls[0].sql).toContain("pg_try_advisory_xact_lock");
    expect(calls[0].params).toEqual([advisoryLockKey(JOB)]);
    expect(state.options).toMatchObject({ timeout: 90_000 });
    expect(state.open).toBe(true);

    await handle!.release();
    expect(state.open).toBe(false);
    await handle!.release(); // idempotent
  });

  it("returns null and closes the transaction when another session holds the lock", async () => {
    const { prisma, state } = fakePrisma(false);
    const handle = await createPrismaAdvisoryLockBackend(prisma as any).tryAcquire("1");
    expect(handle).toBeNull();
    await tick();
    expect(state.open).toBe(false);
  });

  it("propagates connection errors while acquiring", async () => {
    const { prisma } = fakePrisma("error");
    await expect(createPrismaAdvisoryLockBackend(prisma as any).tryAcquire("1")).rejects.toThrow("connection refused");
  });

  it("flags the handle as lost if the lock transaction dies mid-job", async () => {
    const { prisma, state } = fakePrisma(true);
    const handle = await createPrismaAdvisoryLockBackend(prisma as any).tryAcquire("1");
    expect(handle!.lost).toBe(false);
    state.endTransaction!(new Error("terminating connection"));
    await tick();
    expect(handle!.lost).toBe(true);
    await expect(handle!.release()).resolves.toBeUndefined();
  });
});

describe("Prisma run store", () => {
  it("maps the store operations onto scheduledJobRun queries", async () => {
    const model = {
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "r1" }),
      update: jest.fn().mockResolvedValue({}),
    };
    const store = createPrismaJobRunStore({ scheduledJobRun: model });
    const now = new Date();

    expect(await store.abandonRunning(JOB, now)).toBe(2);
    expect(model.updateMany).toHaveBeenCalledWith({
      where: { jobName: JOB, status: "running" },
      data: { status: "abandoned", finishedAt: now },
    });

    await store.findLastCompleted(JOB);
    expect(model.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { jobName: JOB, status: { in: ["succeeded", "failed"] } } })
    );

    await store.start({ jobName: JOB, instanceId: "i1", startedAt: now });
    expect(model.create).toHaveBeenCalledWith({ data: { jobName: JOB, instanceId: "i1", startedAt: now, status: "running" } });

    await store.finish("r1", { status: "failed", finishedAt: now, durationMs: 5, error: "x".repeat(2000) });
    expect(model.update.mock.calls[0][0].data.error).toHaveLength(1000);
  });
});
