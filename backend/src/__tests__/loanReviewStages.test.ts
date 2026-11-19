// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Tests for service-level timers for loan review stages (issue #1047):
 *   - stage duration calculation (`summarizeStageDurations`),
 *   - the writer that opens/closes stage intervals,
 *   - the stuck-stage threshold alert (`runStuckStageAlertScan`),
 *   - the admin summary endpoint (`GET /api/admin/loans/stage-durations`).
 */

import express from "express";
import request from "supertest";

const mockTimerFindMany = jest.fn();
const mockTimerUpdateMany = jest.fn();
const mockTimerCreate = jest.fn();

jest.mock("../services/db.js", () => ({
  prisma: {
    loanReviewStageTimer: {
      findMany: (...args: any[]) => mockTimerFindMany(...args),
      updateMany: (...args: any[]) => mockTimerUpdateMany(...args),
      create: (...args: any[]) => mockTimerCreate(...args),
    },
  },
}));
jest.mock("../services/email.js", () => ({ sendEmail: jest.fn() }));
jest.mock("../services/webhook.js", () => ({ sendWebhook: jest.fn() }));
jest.mock("../services/inviteCode.js", () => ({ promoteWaitlistBatch: jest.fn() }));
jest.mock("../services/loanStore.js", () => ({
  bulkReviewApplications: jest.fn(),
  getApplication: jest.fn(),
}));
jest.mock("../jobs/escrowReconciliation.js", () => ({ runEscrowReconciliation: jest.fn() }));
jest.mock("../config.js", () => ({
  loadConfig: () => ({
    adminApiKey: "test-admin-key",
    reviewStageStuckThresholdHours: 72,
    opsFallbackAlertEmail: "ops@example.com",
    opsSlackWebhookUrl: null,
  }),
}));
jest.mock("../middleware/auth.js", () => ({
  requireAdmin: (req: any, res: any, next: any) =>
    req.headers.authorization === "Bearer test-admin-key"
      ? next()
      : res.status(401).json({ error: "missing_authorization" }),
}));

import { adminRouter } from "../routes/admin.js";
import {
  recordStageEnter,
  transitionReviewStage,
  summarizeStageDurations,
  runStuckStageAlertScan,
  REVIEW_STAGES,
} from "../services/loanReviewStages.js";

const HOUR = 3_600_000;

describe("summarizeStageDurations", () => {
  const periodStart = new Date("2026-11-01T00:00:00.000Z");
  const periodEnd = new Date("2026-11-30T00:00:00.000Z");
  const enteredAt = new Date("2026-11-10T00:00:00.000Z");

  it("reports average and worst-case duration per stage", () => {
    const report = summarizeStageDurations(
      [
        { stage: "Pending", enteredAt, leftAt: new Date(enteredAt.getTime() + 2 * HOUR) },
        { stage: "Pending", enteredAt, leftAt: new Date(enteredAt.getTime() + 4 * HOUR) },
        { stage: "Approved", enteredAt, leftAt: new Date(enteredAt.getTime() + HOUR) },
      ],
      { periodStart, periodEnd, now: periodEnd }
    );

    const pending = report.stages.find((s) => s.stage === "Pending")!;
    expect(pending).toMatchObject({
      completedCount: 2,
      openCount: 0,
      averageMs: 3 * HOUR,
      worstCaseMs: 4 * HOUR,
    });

    const approved = report.stages.find((s) => s.stage === "Approved")!;
    expect(approved).toMatchObject({
      completedCount: 1,
      openCount: 0,
      averageMs: HOUR,
      worstCaseMs: HOUR,
    });
  });

  it("counts still-open intervals separately without a duration", () => {
    const report = summarizeStageDurations(
      [
        { stage: "Pending", enteredAt, leftAt: null },
        { stage: "Pending", enteredAt, leftAt: new Date(enteredAt.getTime() + HOUR) },
      ],
      { periodStart, periodEnd, now: periodEnd }
    );

    const pending = report.stages.find((s) => s.stage === "Pending")!;
    expect(pending).toMatchObject({ completedCount: 1, openCount: 1, averageMs: HOUR, worstCaseMs: HOUR });
  });

  it("always reports every stage, even those with no intervals", () => {
    const report = summarizeStageDurations([], { periodStart, periodEnd, now: periodEnd });
    expect(report.stages).toHaveLength(REVIEW_STAGES.length);
    for (const stage of REVIEW_STAGES) {
      const summary = report.stages.find((s) => s.stage === stage);
      expect(summary).toMatchObject({ completedCount: 0, openCount: 0, averageMs: null, worstCaseMs: null });
    }
  });

  it("ignores intervals that entered outside the period", () => {
    const report = summarizeStageDurations(
      [
        { stage: "Pending", enteredAt: new Date("2026-10-15T00:00:00.000Z"), leftAt: new Date("2026-10-15T05:00:00.000Z") },
      ],
      { periodStart, periodEnd, now: periodEnd }
    );
    expect(report.stages.find((s) => s.stage === "Pending")).toMatchObject({ completedCount: 0, worstCaseMs: null });
  });
});

describe("stage interval writer", () => {
  beforeEach(() => {
    mockTimerCreate.mockReset();
    mockTimerUpdateMany.mockReset();
  });

  it("opens an interval when an application enters a stage", async () => {
    mockTimerCreate.mockResolvedValue({});
    const at = new Date("2026-11-19T10:00:00.000Z");

    await recordStageEnter(undefined, "app-1", "Pending", at);

    expect(mockTimerCreate).toHaveBeenCalledWith({
      data: { applicationId: "app-1", stage: "Pending", enteredAt: at },
    });
  });

  it("closes the open interval and opens the next one on transition", async () => {
    mockTimerUpdateMany.mockResolvedValue({ count: 1 });
    mockTimerCreate.mockResolvedValue({});
    const at = new Date("2026-11-19T11:00:00.000Z");

    await transitionReviewStage(undefined, "app-1", "Approved", at);

    expect(mockTimerUpdateMany).toHaveBeenCalledWith({
      where: { applicationId: "app-1", leftAt: null },
      data: { leftAt: at },
    });
    expect(mockTimerCreate).toHaveBeenCalledWith({
      data: { applicationId: "app-1", stage: "Approved", enteredAt: at },
    });
  });
});

describe("runStuckStageAlertScan", () => {
  const now = new Date("2026-11-19T12:00:00.000Z");

  function stuckRow(id: string, applicationId: string, hoursAgo: number) {
    return {
      id,
      applicationId,
      stage: "Pending",
      enteredAt: new Date(now.getTime() - hoursAgo * HOUR),
      leftAt: null,
      alertSentAt: null,
    };
  }

  beforeEach(() => {
    mockTimerFindMany.mockReset();
    mockTimerUpdateMany.mockReset();
  });

  it("alerts exactly once for an interval past the threshold and skips fresh ones", async () => {
    mockTimerFindMany.mockResolvedValue([
      stuckRow("t1", "app-stuck", 100),
      stuckRow("t2", "app-fresh", 2),
    ]);
    mockTimerUpdateMany.mockResolvedValue({ count: 1 });

    const delivered: any[] = [];
    const result = await runStuckStageAlertScan({
      now,
      thresholdHours: 72,
      sendAlert: async (alert) => {
        delivered.push(alert);
      },
    });

    expect(result.scannedCount).toBe(2);
    expect(result.alertedCount).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ applicationId: "app-stuck", stage: "Pending", thresholdHours: 72 });
    // Only the stuck interval was claimed, and it was claimed before delivery.
    expect(mockTimerUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockTimerUpdateMany).toHaveBeenCalledWith({
      where: { id: "t1", alertSentAt: null },
      data: { alertSentAt: now },
    });
  });

  it("does not re-deliver when a concurrent scan already claimed the interval", async () => {
    mockTimerFindMany.mockResolvedValue([stuckRow("t1", "app-stuck", 100)]);
    // The atomic claim loses the race: another scan already stamped the row.
    mockTimerUpdateMany.mockResolvedValue({ count: 0 });

    const sendAlert = jest.fn();
    const result = await runStuckStageAlertScan({ now, thresholdHours: 72, sendAlert });

    expect(result.alertedCount).toBe(0);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("releases the claim when delivery fails so a later scan retries", async () => {
    mockTimerFindMany.mockResolvedValue([stuckRow("t1", "app-stuck", 100)]);
    mockTimerUpdateMany.mockResolvedValue({ count: 1 });

    const sendAlert = jest.fn().mockRejectedValue(new Error("smtp down"));
    const result = await runStuckStageAlertScan({ now, thresholdHours: 72, sendAlert });

    expect(result.alertedCount).toBe(0);
    expect(mockTimerUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "t1", alertSentAt: null },
      data: { alertSentAt: now },
    });
    expect(mockTimerUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "t1", alertSentAt: now },
      data: { alertSentAt: null },
    });
  });
});

describe("GET /api/admin/loans/stage-durations", () => {
  const app = express();
  app.use("/api/admin", adminRouter);

  beforeEach(() => mockTimerFindMany.mockReset());

  function row(stage: string, enteredAt: Date, leftAt: Date | null) {
    return { stage, enteredAt, leftAt };
  }

  it("requires admin auth", async () => {
    const res = await request(app).get("/api/admin/loans/stage-durations");
    expect(res.status).toBe(401);
    expect(mockTimerFindMany).not.toHaveBeenCalled();
  });

  it("summarises average and worst-case per stage over an explicit period", async () => {
    const since = "2026-11-01T00:00:00.000Z";
    const until = "2026-11-30T00:00:00.000Z";
    const enteredAt = new Date("2026-11-10T00:00:00.000Z");

    mockTimerFindMany.mockResolvedValue([
      row("Pending", enteredAt, new Date(enteredAt.getTime() + 2 * HOUR)),
      row("Pending", enteredAt, new Date(enteredAt.getTime() + 4 * HOUR)),
      row("Approved", enteredAt, new Date(enteredAt.getTime() + HOUR)),
      row("Approved", enteredAt, null),
    ]);

    const res = await request(app)
      .get(`/api/admin/loans/stage-durations?since=${since}&until=${until}`)
      .set("Authorization", "Bearer test-admin-key");

    expect(res.status).toBe(200);
    expect(res.body.periodStart).toBe(since);
    expect(res.body.periodEnd).toBe(until);

    const pending = res.body.stages.find((s: any) => s.stage === "Pending");
    expect(pending).toMatchObject({ completedCount: 2, averageMs: 3 * HOUR, worstCaseMs: 4 * HOUR });

    const approved = res.body.stages.find((s: any) => s.stage === "Approved");
    expect(approved).toMatchObject({ completedCount: 1, openCount: 1, averageMs: HOUR, worstCaseMs: HOUR });

    // The period filters on the interval entry time.
    const where = mockTimerFindMany.mock.calls[0][0].where.enteredAt;
    expect(where.gte).toEqual(new Date(since));
    expect(where.lte).toEqual(new Date(until));
  });

  it("defaults to a trailing window when no period is supplied", async () => {
    mockTimerFindMany.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/admin/loans/stage-durations")
      .set("Authorization", "Bearer test-admin-key");

    expect(res.status).toBe(200);
    const where = mockTimerFindMany.mock.calls[0][0].where.enteredAt;
    const windowMs = where.lte.getTime() - where.gte.getTime();
    expect(windowMs).toBe(30 * 24 * HOUR);
  });

  it("honours a windowDays override", async () => {
    mockTimerFindMany.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/admin/loans/stage-durations?windowDays=7")
      .set("Authorization", "Bearer test-admin-key");

    expect(res.status).toBe(200);
    const where = mockTimerFindMany.mock.calls[0][0].where.enteredAt;
    expect(where.lte.getTime() - where.gte.getTime()).toBe(7 * 24 * HOUR);
  });

  it.each([
    "since=not-a-date",
    "until=not-a-date",
    "since=2026-11-30T00:00:00.000Z&until=2026-11-01T00:00:00.000Z",
    "windowDays=0",
    "windowDays=abc",
    "windowDays=9999",
  ])("rejects invalid period %s", async (query) => {
    const res = await request(app)
      .get(`/api/admin/loans/stage-durations?${query}`)
      .set("Authorization", "Bearer test-admin-key");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_period" });
  });
});
