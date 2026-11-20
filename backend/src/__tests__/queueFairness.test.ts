// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  FairQueueScheduler,
  JobPriorityClass,
  JobLane,
  JOB_LANE_CATALOG,
  LANE_PRIORITY,
  DEFAULT_WORKER_WEIGHTS,
  laneForNotificationType,
  laneForPriority,
} from "../services/queueFairness.js";

describe("FairQueueScheduler", () => {
  it("runs an urgent job before a large bulk backlog", () => {
    const scheduler = new FairQueueScheduler({ perTenantCap: 1000 });
    for (let i = 0; i < 100; i += 1) {
      scheduler.submit({ id: `bulk-${i}`, tenantId: "tenant-a", priority: JobPriorityClass.BULK }, i);
    }
    scheduler.submit({ id: "security-1", tenantId: "tenant-b", priority: JobPriorityClass.SECURITY }, 100);

    const first = scheduler.dequeue(101);
    expect(first?.id).toBe("security-1");
  });

  it("lets a starving low-lane job overtake newer high-lane work", () => {
    const scheduler = new FairQueueScheduler({
      perTenantCap: 1000,
      starvationThresholdMs: 1000,
    });
    scheduler.submit({ id: "low-1", tenantId: "tenant-a", priority: JobPriorityClass.BULK }, 0);
    scheduler.submit({ id: "high-1", tenantId: "tenant-b", priority: JobPriorityClass.SECURITY }, 1500);

    // high-1 is younger than the fair-share threshold, low-1 has exceeded it.
    expect(scheduler.dequeue(2000)?.id).toBe("low-1");
    expect(scheduler.dequeue(2000)?.id).toBe("high-1");
  });

  it("assigns every existing job type to exactly one public lane", () => {
    for (const type of Object.keys(JOB_LANE_CATALOG)) {
      expect(Object.values(JobLane)).toContain(JOB_LANE_CATALOG[type as keyof typeof JOB_LANE_CATALOG]);
    }

    expect(JOB_LANE_CATALOG["notification.EMAIL"]).toBe(JobLane.HIGH);
    expect(JOB_LANE_CATALOG["notification.WEBHOOK"]).toBe(JobLane.HIGH);
    expect(JOB_LANE_CATALOG["notification.SMS"]).toBe(JobLane.HIGH);
    expect(JOB_LANE_CATALOG["notification.PUSH"]).toBe(JobLane.NORMAL);
    expect(JOB_LANE_CATALOG["webhook.delivery"]).toBe(JobLane.NORMAL);
    expect(JOB_LANE_CATALOG["email.send"]).toBe(JobLane.NORMAL);
    expect(JOB_LANE_CATALOG["analytics.persist"]).toBe(JobLane.LOW);
    expect(JOB_LANE_CATALOG["report.generate"]).toBe(JobLane.LOW);
  });

  it("maps BullMQ priority numbers and notification types onto lanes", () => {
    expect(laneForPriority(LANE_PRIORITY[JobLane.HIGH])).toBe(JobLane.HIGH);
    expect(laneForPriority(LANE_PRIORITY[JobLane.NORMAL])).toBe(JobLane.NORMAL);
    expect(laneForPriority(LANE_PRIORITY[JobLane.LOW])).toBe(JobLane.LOW);
    expect(laneForPriority(undefined)).toBe(JobLane.NORMAL);

    expect(laneForNotificationType("EMAIL")).toBe(JobLane.HIGH);
    expect(laneForNotificationType("PUSH")).toBe(JobLane.NORMAL);
    expect(laneForNotificationType("UNKNOWN")).toBe(JobLane.NORMAL);
  });

  it("prevents one tenant from occupying every worker", () => {
    const scheduler = new FairQueueScheduler({ perTenantCap: 2 });
    for (let i = 0; i < 10; i += 1) {
      scheduler.submit({ id: `a-${i}`, tenantId: "tenant-a", priority: JobPriorityClass.NORMAL }, i);
    }
    scheduler.submit({ id: "b-0", tenantId: "tenant-b", priority: JobPriorityClass.NORMAL }, 10);

    expect(scheduler.dequeue(11)?.tenantId).toBe("tenant-a");
    expect(scheduler.dequeue(12)?.tenantId).toBe("tenant-a");
    // tenant-a is now at its cap, so the next runnable job is tenant-b's.
    const third = scheduler.dequeue(13);
    expect(third?.tenantId).toBe("tenant-b");
    expect(scheduler.activeCount("tenant-a")).toBe(2);
  });

  it("records wait time per priority class", () => {
    const scheduler = new FairQueueScheduler();
    scheduler.submit({ id: "u-1", tenantId: "t", priority: JobPriorityClass.URGENT }, 0);
    const job = scheduler.dequeue(0);
    expect(job?.id).toBe("u-1");
    scheduler.complete("u-1", 250);

    const stats = scheduler.waitTimeByPriority();
    expect(stats[JobPriorityClass.URGENT]).toEqual({ count: 1, avgMs: 250, maxMs: 250 });
    expect(stats[JobPriorityClass.BULK].count).toBe(0);
  });

  it("reports starvation when a high-priority job waits too long", () => {
    const scheduler = new FairQueueScheduler({ starvationThresholdMs: 30_000, perTenantCap: 0 });
    scheduler.submit({ id: "sec", tenantId: "t", priority: JobPriorityClass.SECURITY }, 0);

    expect(scheduler.isStarving(10_000)).toBe(false);

    const report = scheduler.starvationReport(45_000);
    expect(report.starving).toBe(true);
    expect(report.priority).toBe(JobPriorityClass.SECURITY);
    expect(report.oldestWaitMs).toBe(45_000);
  });

  it("allocates the whole worker pool by weight", () => {
    const scheduler = new FairQueueScheduler();
    const alloc = scheduler.allocateWorkers(10);
    const total = Object.values(alloc).reduce((a, b) => a + b, 0);
    expect(total).toBe(10);
    // Bulk must never take the whole pool.
    expect(alloc[JobPriorityClass.BULK]).toBeLessThan(10);
    expect(Object.values(DEFAULT_WORKER_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it("returns null when every waiting tenant is at its cap", () => {
    const scheduler = new FairQueueScheduler({ perTenantCap: 1 });
    scheduler.submit({ id: "only", tenantId: "t", priority: JobPriorityClass.NORMAL }, 0);
    expect(scheduler.dequeue(1)?.id).toBe("only");
    scheduler.submit({ id: "blocked", tenantId: "t", priority: JobPriorityClass.NORMAL }, 2);
    expect(scheduler.dequeue(3)).toBeNull();
  });
});
