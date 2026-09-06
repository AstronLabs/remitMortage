jest.mock("../services/db.js", () => ({
  prisma: {
    analyticsEvent: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  },
}));

jest.mock("../services/queueService.js", () => ({
  queueService: { addAnalyticsJob: jest.fn().mockResolvedValue({ id: "job-1" }) },
}));

import {
  getAnalyticsCounts,
  getAnalyticsFunnel,
  enqueueAnalyticsEvents,
  persistAnalyticsEvents,
  validateAnalyticsInput,
} from "../services/analyticsEvents.js";
import { prisma } from "../services/db.js";

describe("analytics event pipeline", () => {
  const input = {
    event: "loan_application_submitted",
    properties: { loanType: "mortgage" },
    timestamp: "2026-08-27T10:00:00.000Z",
  };

  it("validates structured, bounded events", () => {
    expect(validateAnalyticsInput(input)).toBe(true);
    expect(validateAnalyticsInput({ ...input, event: "Bad Event" })).toBe(false);
    expect(validateAnalyticsInput({ ...input, properties: { value: "x".repeat(16_385) } })).toBe(false);
    expect(validateAnalyticsInput({ ...input, timestamp: "not-a-date" })).toBe(false);
  });

  it("persists a batch with duplicate-safe insertion", async () => {
    await persistAnalyticsEvents([{ ...input, id: "event-1", userId: "wallet-1" }]);
    expect(prisma.analyticsEvent.createMany).toHaveBeenCalledWith(expect.objectContaining({
      skipDuplicates: true,
      data: [expect.objectContaining({ id: "event-1", userId: "wallet-1" })],
    }));
  });

  it("maps count and distinct-user funnel queries", async () => {
    (prisma.analyticsEvent.groupBy as jest.Mock).mockResolvedValueOnce([
      { event: "loan_application_submitted", _count: { _all: 2 } },
    ]);
    (prisma.analyticsEvent.count as jest.Mock).mockResolvedValueOnce(3).mockResolvedValueOnce(2);
    await expect(getAnalyticsCounts(new Date("2026-08-01"), new Date("2026-09-01")))
      .resolves.toEqual([{ event: "loan_application_submitted", count: 2 }]);
    await expect(getAnalyticsFunnel(new Date("2026-08-01"), new Date("2026-09-01"), ["started", "submitted"]))
      .resolves.toEqual({ steps: [{ event: "started", count: 3 }, { event: "submitted", count: 2 }] });
    expect(prisma.analyticsEvent.count).toHaveBeenCalledWith(expect.objectContaining({ distinct: ["userId"] }));
  });

  it("does not enqueue events when analytics is disabled", async () => {
    const previous = process.env.ANALYTICS_ENABLED;
    try {
      process.env.ANALYTICS_ENABLED = "false";
      await expect(enqueueAnalyticsEvents("wallet-1", [input])).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.ANALYTICS_ENABLED;
      else process.env.ANALYTICS_ENABLED = previous;
    }
  });
});