// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * In-memory stand-ins for PostgreSQL advisory locks and the ScheduledJobRun
 * table, so tests can race many simulated instances for the same job.
 *
 * Each `connect()` is one "database session". Like `pg_try_advisory_xact_lock`
 * the lock is exclusive across sessions and is released when the session
 * releases it *or dies* (`crash()`), with no TTL.
 */

import type {
  AdvisoryLockBackend,
  AdvisoryLockHandle,
  JobRunRecord,
  JobRunStore,
} from "../services/jobLeaderElection.js";

interface Held {
  session: Session;
  handle: MemoryHandle;
}

class MemoryHandle implements AdvisoryLockHandle {
  lost = false;
  constructor(
    private readonly manager: InMemoryLockManager,
    private readonly key: string
  ) {}
  async release(): Promise<void> {
    this.manager.releaseKey(this.key, this);
  }
}

export class Session implements AdvisoryLockBackend {
  alive = true;
  constructor(
    readonly name: string,
    private readonly manager: InMemoryLockManager
  ) {}

  async tryAcquire(lockKey: string): Promise<AdvisoryLockHandle | null> {
    if (!this.alive) throw new Error(`session ${this.name} is dead`);
    // Yield like a real round-trip so racing instances genuinely interleave.
    await Promise.resolve();
    return this.manager.tryLock(this, lockKey);
  }
}

export class InMemoryLockManager {
  private readonly held = new Map<string, Held>();
  /** Every acquisition attempt, in order — for assertions. */
  readonly attempts: Array<{ session: string; key: string; acquired: boolean }> = [];

  connect(name: string): Session {
    return new Session(name, this);
  }

  tryLock(session: Session, key: string): AdvisoryLockHandle | null {
    if (this.held.has(key)) {
      this.attempts.push({ session: session.name, key, acquired: false });
      return null;
    }
    const handle = new MemoryHandle(this, key);
    this.held.set(key, { session, handle });
    this.attempts.push({ session: session.name, key, acquired: true });
    return handle;
  }

  releaseKey(key: string, handle: MemoryHandle): void {
    if (this.held.get(key)?.handle === handle) this.held.delete(key);
  }

  /** Simulate the process dying: its session ends and PostgreSQL drops its locks. */
  crash(session: Session): void {
    session.alive = false;
    for (const [key, held] of [...this.held]) {
      if (held.session === session) {
        held.handle.lost = true;
        this.held.delete(key);
      }
    }
  }

  isLocked(key: string): boolean {
    return this.held.has(key);
  }
}

/** Shared run table (one per simulated database). */
export class InMemoryJobRunStore implements JobRunStore {
  readonly rows: JobRunRecord[] = [];
  private nextId = 1;

  async abandonRunning(jobName: string, now: Date): Promise<number> {
    let count = 0;
    for (const row of this.rows) {
      if (row.jobName === jobName && row.status === "running") {
        row.status = "abandoned";
        row.finishedAt = now;
        count++;
      }
    }
    return count;
  }

  async findLastCompleted(jobName: string): Promise<JobRunRecord | null> {
    return (
      this.rows
        .filter((r) => r.jobName === jobName && (r.status === "succeeded" || r.status === "failed"))
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0] ?? null
    );
  }

  async start(run: { jobName: string; instanceId: string; startedAt: Date }): Promise<JobRunRecord> {
    const row: JobRunRecord = { id: `run-${this.nextId++}`, status: "running", ...run };
    this.rows.push(row);
    return row;
  }

  async finish(
    id: string,
    patch: { status: "succeeded" | "failed"; finishedAt: Date; durationMs: number; error?: string }
  ): Promise<void> {
    // safe-merge-ok: in-memory test double patching its own typed row with a fixed-shape patch
    Object.assign(this.rows.find((r) => r.id === id)!, patch);
  }
}
