// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Unit tests for accredited-investor periodic re-verification (issue #725).
 *
 * Acceptance criteria under test:
 * 1. An investor approaching their re-verification deadline receives a reminder.
 * 2. An investor lapsed past the grace period is blocked from new investments
 *    until re-verified.
 */

interface Row {
  id: string;
  investorAddress: string;
  lastVerifiedAt: Date;
  reminderSentAt: Date | null;
  missedReminderSentAt: Date | null;
}

const DAY = 24 * 60 * 60 * 1000;
let rows: Row[] = [];
const createInAppNotificationMock = jest.fn();

jest.mock("../services/db.js", () => ({
  createInAppNotification: (...args: unknown[]) => createInAppNotificationMock(...args),
  prisma: {
    investorAccreditation: {
      findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.investorAddress === where.investorAddress) ?? null),
      findMany: jest.fn(async ({ where }: any) =>
        rows.filter((r) => {
          if ("reminderSentAt" in where && r.reminderSentAt !== where.reminderSentAt) return false;
          if ("missedReminderSentAt" in where && r.missedReminderSentAt !== where.missedReminderSentAt) return false;
          if (where.lastVerifiedAt?.lte && r.lastVerifiedAt > where.lastVerifiedAt.lte) return false;
          return true;
        })
      ),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = rows.find((r) => r.investorAddress === where.investorAddress);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row: Row = { id: `r${rows.length + 1}`, reminderSentAt: null, missedReminderSentAt: null, ...create };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
  },
}));

import {
  InvestmentRestrictedError,
  assertInvestmentAllowed,
  computeReverificationState,
  recordInvestorVerification,
  runReverificationSweep,
} from "../services/investorReverification.js";

const NOW = new Date("2027-06-01T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

function seed(investorAddress: string, lastVerifiedAt: Date) {
  rows.push({
    id: `r${rows.length + 1}`,
    investorAddress,
    lastVerifiedAt,
    reminderSentAt: null,
    missedReminderSentAt: null,
  });
}

beforeEach(() => {
  rows = [];
  createInAppNotificationMock.mockReset().mockResolvedValue({});
  delete process.env.REVERIFICATION_INTERVAL_DAYS;
  delete process.env.REVERIFICATION_REMINDER_LEAD_DAYS;
  delete process.env.REVERIFICATION_GRACE_DAYS;
});

describe("computeReverificationState", () => {
  it("walks current -> due_soon -> overdue -> lapsed with defaults (365/30/30)", () => {
    const status = (d: number) => computeReverificationState(daysAgo(d), NOW).status;
    expect(status(100)).toBe("current");
    expect(status(334)).toBe("current");
    expect(status(335)).toBe("due_soon");
    expect(status(364)).toBe("due_soon");
    expect(status(365)).toBe("overdue");
    expect(status(394)).toBe("overdue");
    expect(status(395)).toBe("lapsed");
  });

  it("only blocks investing once lapsed", () => {
    expect(computeReverificationState(daysAgo(380), NOW).canInvest).toBe(true);
    expect(computeReverificationState(daysAgo(400), NOW).canInvest).toBe(false);
  });

  it("treats investors without a record as untracked and unrestricted", () => {
    const state = computeReverificationState(null, NOW);
    expect(state).toMatchObject({ status: "untracked", canInvest: true });
  });

  it("honours a configurable interval", () => {
    process.env.REVERIFICATION_INTERVAL_DAYS = "180";
    expect(computeReverificationState(daysAgo(200), NOW).status).toBe("overdue");
    expect(computeReverificationState(daysAgo(100), NOW).status).toBe("current");
  });

  it("falls back to defaults on invalid configuration", () => {
    process.env.REVERIFICATION_INTERVAL_DAYS = "-5";
    process.env.REVERIFICATION_GRACE_DAYS = "abc";
    expect(computeReverificationState(daysAgo(364), NOW).status).toBe("due_soon");
    expect(computeReverificationState(daysAgo(394), NOW).status).toBe("overdue");
  });
});

describe("reminder scheduling", () => {
  it("reminds an investor approaching the deadline, exactly once", async () => {
    seed("GAPPROACH", daysAgo(350));
    seed("GFRESH", daysAgo(30));

    expect(await runReverificationSweep(NOW)).toEqual({ reminded: 1, followedUp: 0 });
    expect(createInAppNotificationMock).toHaveBeenCalledTimes(1);
    expect(createInAppNotificationMock.mock.calls[0][0]).toMatchObject({
      walletAddress: "GAPPROACH",
      metadata: { type: "ACCREDITATION_REVERIFICATION_DUE" },
    });

    // Second sweep: already reminded, nothing new.
    expect(await runReverificationSweep(NOW)).toEqual({ reminded: 0, followedUp: 0 });
    expect(createInAppNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("sends a follow-up once the deadline is missed, exactly once", async () => {
    seed("GMISSED", daysAgo(370));

    expect(await runReverificationSweep(NOW)).toEqual({ reminded: 0, followedUp: 1 });
    expect(createInAppNotificationMock.mock.calls[0][0]).toMatchObject({
      walletAddress: "GMISSED",
      metadata: { type: "ACCREDITATION_REVERIFICATION_MISSED", status: "overdue" },
    });
    expect(await runReverificationSweep(NOW)).toEqual({ reminded: 0, followedUp: 0 });
  });

  it("tells a lapsed investor that new investments are blocked", async () => {
    seed("GLAPSED", daysAgo(500));
    await runReverificationSweep(NOW);
    const call = createInAppNotificationMock.mock.calls[0][0];
    expect(call.metadata.status).toBe("lapsed");
    expect(call.message).toMatch(/blocked/);
  });

  it("does not mark an investor reminded when the notification fails, and keeps going", async () => {
    seed("GBAD", daysAgo(350));
    seed("GGOOD", daysAgo(350));
    createInAppNotificationMock.mockRejectedValueOnce(new Error("boom"));

    expect(await runReverificationSweep(NOW)).toEqual({ reminded: 1, followedUp: 0 });
    expect(rows.find((r) => r.investorAddress === "GBAD")!.reminderSentAt).toBeNull();
    expect(rows.find((r) => r.investorAddress === "GGOOD")!.reminderSentAt).not.toBeNull();

    // Retried on the next sweep.
    expect(await runReverificationSweep(NOW)).toEqual({ reminded: 1, followedUp: 0 });
  });

  it("re-verification restarts the cycle and re-arms the reminders", async () => {
    seed("GCYCLE", daysAgo(350));
    await runReverificationSweep(NOW);
    await recordInvestorVerification("GCYCLE", NOW);

    const row = rows[0];
    expect(row.reminderSentAt).toBeNull();
    expect(row.missedReminderSentAt).toBeNull();

    const later = new Date(NOW.getTime() + 350 * DAY);
    expect(await runReverificationSweep(later)).toEqual({ reminded: 1, followedUp: 0 });
  });
});

describe("lapse-based restriction", () => {
  it("allows investing before the deadline and during the grace period", async () => {
    seed("GOK", daysAgo(100));
    seed("GGRACE", daysAgo(380));
    await expect(assertInvestmentAllowed("GOK", NOW)).resolves.toMatchObject({ status: "current" });
    await expect(assertInvestmentAllowed("GGRACE", NOW)).resolves.toMatchObject({ status: "overdue" });
  });

  it("blocks new investments once lapsed past the grace period", async () => {
    seed("GLAPSED", daysAgo(400));
    await expect(assertInvestmentAllowed("GLAPSED", NOW)).rejects.toBeInstanceOf(InvestmentRestrictedError);
  });

  it("unblocks the investor as soon as they are re-verified", async () => {
    seed("GLAPSED", daysAgo(400));
    await expect(assertInvestmentAllowed("GLAPSED", NOW)).rejects.toBeInstanceOf(InvestmentRestrictedError);
    await recordInvestorVerification("GLAPSED", NOW);
    await expect(assertInvestmentAllowed("GLAPSED", NOW)).resolves.toMatchObject({ status: "current" });
  });

  it("respects a configurable grace period", async () => {
    process.env.REVERIFICATION_GRACE_DAYS = "0";
    seed("GSTRICT", daysAgo(366));
    await expect(assertInvestmentAllowed("GSTRICT", NOW)).rejects.toBeInstanceOf(InvestmentRestrictedError);
  });

  it("never restricts untracked investors", async () => {
    await expect(assertInvestmentAllowed("GUNKNOWN", NOW)).resolves.toMatchObject({ status: "untracked" });
  });
});
