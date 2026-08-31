import { runRepaymentAudit } from "../jobs/repaymentAudit.js";
import { prisma } from "../services/db.js";
import { queueNotification } from "../services/notification.js";

jest.mock("../services/db.js", () => ({
  prisma: {
    loanApplication: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
    applicant: {
      findUnique: jest.fn(),
    },
  },
}));

jest.mock("../services/notification.js", () => ({
  queueNotification: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Existing tests — preserved exactly as before (issue #529 must not regress)
// ---------------------------------------------------------------------------

describe("Repayment Audit Scheduler", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Mock an applicant
    (prisma.applicant.findUnique as jest.Mock).mockResolvedValue({
      id: "applicant-1",
      stellarAddress: "GABCD",
    });
  });

  it("should enter grace period when payment is overdue and no grace period exists", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
      {
        id: "loan-1",
        applicantId: "applicant-1",
        status: "ACTIVE",
        dueDate: yesterday,
        gracePeriodEndsAt: null,
        missedPayments: 0,
        lateFeeBalance: 0,
      },
    ]);

    await runRepaymentAudit();

    expect(prisma.loanApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "loan-1" },
        data: expect.objectContaining({
          gracePeriodEndsAt: expect.any(Date),
        }),
      })
    );

    expect(queueNotification).toHaveBeenCalledWith(
      "GABCD@example.com",
      "EMAIL",
      expect.stringContaining("grace period")
    );
  });

  it("should apply late fee and increment missed payments when grace period expires", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
      {
        id: "loan-2",
        applicantId: "applicant-1",
        status: "ACTIVE",
        dueDate: yesterday,
        gracePeriodEndsAt: yesterday, // Expired
        missedPayments: 1,
        lateFeeBalance: 50,
      },
    ]);

    await runRepaymentAudit();

    expect(prisma.loanApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "loan-2" },
        data: expect.objectContaining({
          missedPayments: 2,
          lateFeeBalance: 100,
          gracePeriodEndsAt: null,
          dueDate: expect.any(Date), // Next due date
        }),
      })
    );

    expect(queueNotification).toHaveBeenCalledWith(
      "GABCD@example.com",
      "EMAIL",
      expect.stringContaining("late fee")
    );
  });

  it("should transition loan to DEFAULTED on 3rd consecutive missed payment", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
      {
        id: "loan-3",
        applicantId: "applicant-1",
        status: "ACTIVE",
        dueDate: yesterday,
        gracePeriodEndsAt: yesterday, // Expired
        missedPayments: 2, // This will be the 3rd miss
        lateFeeBalance: 100,
      },
    ]);

    await runRepaymentAudit();

    expect(prisma.loanApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "loan-3" },
        data: expect.objectContaining({
          missedPayments: 3,
          lateFeeBalance: 150,
          gracePeriodEndsAt: null,
          status: "DEFAULTED",
        }),
      })
    );

    expect(queueNotification).toHaveBeenCalledWith(
      "GABCD@example.com",
      "EMAIL",
      expect.stringContaining("defaulted")
    );
  });
});

// ---------------------------------------------------------------------------
// Issue #529 — Timezone and DST edge cases in payment due-date calculations
//
// Design notes
// ────────────
// • All "now" values are pinned via jest.setSystemTime() so tests are fully
//   deterministic regardless of when or where they run.
//
// • process.env.TZ is changed per-test to exercise timezone-sensitive code
//   paths.  The original value is captured in beforeAll and restored in
//   afterEach so no state leaks — whether the runner starts with TZ=UTC,
//   TZ=America/New_York, or TZ unset.  Restoring to a hard-coded "UTC" would
//   be wrong on a server whose original TZ was undefined (OS timezone) or
//   any non-UTC zone.
//
// • Fake timers are installed in beforeAll and restored in afterAll for the
//   whole describe block; no individual test needs to touch the timer state.
//
// Why "now" must be BEFORE the DST boundary, not AT it
// ─────────────────────────────────────────────────────
// setDate(getDate() + N) and setUTCDate(getUTCDate() + N) only diverge when
// the N-day arithmetic CROSSES a DST transition, not when it starts at one.
// Pinning "now" to the transition instant itself means both functions start
// at the same local and UTC hour and land at the same result — the test
// would pass even against the broken pre-fix code.
//
// To expose the bug, "now" must be set a few days before the transition so
// that +3 days (or +30 days) straddles the DST boundary.
//
// Concrete examples:
//   US Eastern spring-forward 2025-03-09T07:00Z (02:00→03:00 EST→EDT)
//     now = 2025-03-07T22:00Z (Fri 5pm EST) — +3 days crosses Sunday
//     broken setDate:   Mar10 5pm EDT = 2025-03-10T21:00Z  (−1 h off)
//     fixed setUTCDate: Mar10 22:00Z  = 2025-03-10T22:00Z  (exact)
//
//   US Eastern fall-back 2025-11-02T06:00Z (02:00→01:00 EDT→EST)
//     now = 2025-10-30T22:00Z (Thu 6pm EDT) — +3 days crosses Sunday
//     broken setDate:   Nov2 6pm EST  = 2025-11-02T23:00Z  (+1 h off)
//     fixed setUTCDate: Nov2 22:00Z   = 2025-11-02T22:00Z  (exact)
// ---------------------------------------------------------------------------

/** 3-day grace period offset in ms (matches GRACE_PERIOD_DAYS = 3) */
const GRACE_MS = 3 * 24 * 60 * 60 * 1000;
/** 30-day next-due offset in ms */
const NEXT_DUE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Overdue loan fixture: dueDate is 1 ms before now, no grace period active.
 * Triggers handleEnterGracePeriod → writes gracePeriodEndsAt.
 */
function overdueNoGrace(now: number) {
  return {
    id: "dst-loan-grace",
    applicantId: "applicant-dst",
    status: "ACTIVE",
    dueDate: new Date(now - 1),
    gracePeriodEndsAt: null,
    missedPayments: 0,
    lateFeeBalance: 0,
  };
}

/**
 * Expired-grace loan fixture: grace period ended 1 ms before now.
 * Triggers handleMissedPayment → writes nextDueDate.
 */
function expiredGrace(now: number, missedPayments = 1) {
  return {
    id: "dst-loan-next",
    applicantId: "applicant-dst",
    status: "ACTIVE",
    dueDate: new Date(now - 2),
    gracePeriodEndsAt: new Date(now - 1),
    missedPayments,
    lateFeeBalance: missedPayments * 50,
  };
}

/** Returns the Date value written to a named field via prisma.loanApplication.update. */
function capturedDate(field: "gracePeriodEndsAt" | "dueDate"): Date {
  const calls = (prisma.loanApplication.update as jest.Mock).mock.calls;
  for (const [arg] of calls) {
    if (arg?.data?.[field] instanceof Date) {
      return arg.data[field] as Date;
    }
  }
  throw new Error(`No update call found with data.${field}`);
}

describe("Issue #529 — Timezone and DST edge cases", () => {
  const applicantMock = { id: "applicant-dst", stellarAddress: "GDST" };

  // Capture the original TZ once so afterEach can restore it faithfully on
  // any runner (CI with TZ=UTC, local dev with TZ unset, staging with TZ=EST…).
  let originalTZ: string | undefined;

  beforeAll(() => {
    originalTZ = process.env.TZ;
    jest.useFakeTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
    // Full restoration: if TZ was originally absent, delete the key entirely
    // rather than setting it to "UTC" (which would change behaviour on servers
    // whose OS timezone is not UTC).
    if (originalTZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTZ;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.applicant.findUnique as jest.Mock).mockResolvedValue(applicantMock);
  });

  afterEach(() => {
    // Restore TZ after every test — not just in afterAll — to prevent a
    // failing test from polluting subsequent tests in the same run.
    if (originalTZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTZ;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 1 — DST spring-forward
  //
  // "now" is pinned several days BEFORE the transition so that +3 days
  // of arithmetic crosses it.  This is the only configuration where
  // setDate and setUTCDate produce different UTC timestamps.
  // ─────────────────────────────────────────────────────────────────────────
  describe("DST spring-forward boundaries", () => {
    // US Eastern: spring-forward 2025-03-09T07:00Z (02:00 EST → 03:00 EDT)
    // now = 2025-03-07T22:00Z (Friday 5pm EST) — adding 3 days crosses Sunday
    const nowEasternSpring = Date.UTC(2025, 2, 7, 22, 0, 0, 0);

    it("America/New_York spring-forward: gracePeriodEndsAt is exactly 3×24 h in UTC", async () => {
      process.env.TZ = "America/New_York";
      jest.setSystemTime(nowEasternSpring);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([overdueNoGrace(nowEasternSpring)]);

      await runRepaymentAudit();

      expect(capturedDate("gracePeriodEndsAt").getTime()).toBe(nowEasternSpring + GRACE_MS);
    });

    // US Pacific: spring-forward 2025-03-09T10:00Z (02:00 PST → 03:00 PDT)
    // Same Friday UTC instant — Pacific is 3 h behind Eastern so it too straddles the boundary
    it("America/Los_Angeles spring-forward: gracePeriodEndsAt is exactly 3×24 h in UTC", async () => {
      process.env.TZ = "America/Los_Angeles";
      jest.setSystemTime(nowEasternSpring);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([overdueNoGrace(nowEasternSpring)]);

      await runRepaymentAudit();

      expect(capturedDate("gracePeriodEndsAt").getTime()).toBe(nowEasternSpring + GRACE_MS);
    });

    // Europe/London: spring-forward 2025-03-30T01:00Z (01:00 GMT → 02:00 BST)
    // now = 2025-03-28T12:00Z (Friday noon) — +3 days crosses Sunday
    const nowLondonSpring = Date.UTC(2025, 2, 28, 12, 0, 0, 0);

    it("Europe/London spring-forward: gracePeriodEndsAt is exactly 3×24 h in UTC", async () => {
      process.env.TZ = "Europe/London";
      jest.setSystemTime(nowLondonSpring);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([overdueNoGrace(nowLondonSpring)]);

      await runRepaymentAudit();

      expect(capturedDate("gracePeriodEndsAt").getTime()).toBe(nowLondonSpring + GRACE_MS);
    });

    // Cross-TZ consistency: same UTC instant, three different TZ env settings,
    // must produce identical stored timestamps.
    it("America/New_York, Los_Angeles, Europe/London all produce the same UTC gracePeriodEndsAt", async () => {
      const results: number[] = [];

      for (const tz of ["America/New_York", "America/Los_Angeles", "Europe/London"]) {
        jest.clearAllMocks();
        (prisma.applicant.findUnique as jest.Mock).mockResolvedValue(applicantMock);
        process.env.TZ = tz;
        jest.setSystemTime(nowEasternSpring);
        (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([overdueNoGrace(nowEasternSpring)]);
        await runRepaymentAudit();
        results.push(capturedDate("gracePeriodEndsAt").getTime());
      }

      expect(results[0]).toBe(nowEasternSpring + GRACE_MS);
      expect(results[0]).toBe(results[1]);
      expect(results[1]).toBe(results[2]);
    });

    // Exact ms guard — the stored offset must be exactly 72 h, not 71 h.
    it("America/New_York spring-forward: offset is 259200000 ms (not 71 h)", async () => {
      process.env.TZ = "America/New_York";
      jest.setSystemTime(nowEasternSpring);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([overdueNoGrace(nowEasternSpring)]);

      await runRepaymentAudit();

      const diff = capturedDate("gracePeriodEndsAt").getTime() - nowEasternSpring;
      expect(diff).toBe(GRACE_MS);
      expect(diff).not.toBe(71 * 3600 * 1000); // what setDate would have produced
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 2 — DST fall-back
  //
  // Same principle: "now" is set before the fall-back so +3 days crosses it.
  // ─────────────────────────────────────────────────────────────────────────
  describe("DST fall-back boundaries", () => {
    // US Eastern: fall-back 2025-11-02T06:00Z (02:00 EDT → 01:00 EST)
    // now = 2025-10-30T22:00Z (Thursday 6pm EDT) — +3 days crosses Sunday
    const nowEasternFall = Date.UTC(2025, 9, 30, 22, 0, 0, 0);

    it("America/New_York fall-back: gracePeriodEndsAt is exactly 3×24 h in UTC", async () => {
      process.env.TZ = "America/New_York";
      jest.setSystemTime(nowEasternFall);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([overdueNoGrace(nowEasternFall)]);

      await runRepaymentAudit();

      expect(capturedDate("gracePeriodEndsAt").getTime()).toBe(nowEasternFall + GRACE_MS);
    });

    it("America/New_York fall-back: nextDueDate is exactly 30×24 h in UTC", async () => {
      process.env.TZ = "America/New_York";
      jest.setSystemTime(nowEasternFall);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([expiredGrace(nowEasternFall)]);

      await runRepaymentAudit();

      expect(capturedDate("dueDate").getTime()).toBe(nowEasternFall + NEXT_DUE_MS);
    });

    // US Pacific: fall-back 2025-11-02T09:00Z (02:00 PDT → 01:00 PST)
    // Same Thursday UTC instant straddles the boundary for Pacific too
    it("America/Los_Angeles fall-back: gracePeriodEndsAt is exactly 3×24 h in UTC", async () => {
      process.env.TZ = "America/Los_Angeles";
      jest.setSystemTime(nowEasternFall);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([overdueNoGrace(nowEasternFall)]);

      await runRepaymentAudit();

      expect(capturedDate("gracePeriodEndsAt").getTime()).toBe(nowEasternFall + GRACE_MS);
    });

    it("America/Los_Angeles fall-back: nextDueDate is exactly 30×24 h in UTC", async () => {
      process.env.TZ = "America/Los_Angeles";
      jest.setSystemTime(nowEasternFall);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([expiredGrace(nowEasternFall)]);

      await runRepaymentAudit();

      expect(capturedDate("dueDate").getTime()).toBe(nowEasternFall + NEXT_DUE_MS);
    });

    // Europe/London: fall-back 2025-10-26T01:00Z (02:00 BST → 01:00 GMT)
    // now = 2025-10-24T12:00Z (Friday noon BST) — +3 days crosses Sunday
    const nowLondonFall = Date.UTC(2025, 9, 24, 12, 0, 0, 0);

    it("Europe/London fall-back: gracePeriodEndsAt is exactly 3×24 h in UTC", async () => {
      process.env.TZ = "Europe/London";
      jest.setSystemTime(nowLondonFall);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([overdueNoGrace(nowLondonFall)]);

      await runRepaymentAudit();

      expect(capturedDate("gracePeriodEndsAt").getTime()).toBe(nowLondonFall + GRACE_MS);
    });

    it("Europe/London fall-back: nextDueDate is exactly 30×24 h in UTC", async () => {
      process.env.TZ = "Europe/London";
      jest.setSystemTime(nowLondonFall);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([expiredGrace(nowLondonFall)]);

      await runRepaymentAudit();

      expect(capturedDate("dueDate").getTime()).toBe(nowLondonFall + NEXT_DUE_MS);
    });

    // Exact ms guard — stored offset must be exactly 72 h, not 73 h.
    it("America/New_York fall-back: offset is 259200000 ms (not 73 h)", async () => {
      process.env.TZ = "America/New_York";
      jest.setSystemTime(nowEasternFall);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([overdueNoGrace(nowEasternFall)]);

      await runRepaymentAudit();

      const diff = capturedDate("gracePeriodEndsAt").getTime() - nowEasternFall;
      expect(diff).toBe(GRACE_MS);
      expect(diff).not.toBe(73 * 3600 * 1000); // what setDate would have produced
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 3 — Africa/Lagos (UTC+1, no DST ever)
  //
  // Confirms the fix doesn't break stable-offset zones and satisfies the
  // issue requirement to cover Africa/Lagos explicitly.
  // ─────────────────────────────────────────────────────────────────────────
  describe("Africa/Lagos — no DST, UTC+1 offset", () => {
    const nowMs = Date.UTC(2025, 5, 15, 11, 0, 0, 0); // 2025-06-15T11:00:00Z

    it("gracePeriodEndsAt is exactly 3×24 h after now in UTC", async () => {
      process.env.TZ = "Africa/Lagos";
      jest.setSystemTime(nowMs);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([overdueNoGrace(nowMs)]);

      await runRepaymentAudit();

      expect(capturedDate("gracePeriodEndsAt").getTime()).toBe(nowMs + GRACE_MS);
    });

    it("nextDueDate is exactly 30×24 h after now in UTC", async () => {
      process.env.TZ = "Africa/Lagos";
      jest.setSystemTime(nowMs);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([expiredGrace(nowMs)]);

      await runRepaymentAudit();

      expect(capturedDate("dueDate").getTime()).toBe(nowMs + NEXT_DUE_MS);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 4 — UTC storage consistency across 7 timezones
  //
  // Same UTC instant, seven different TZ settings — the stored value must
  // be byte-for-byte identical.  Uses a mid-year instant where no DST
  // transition is nearby to isolate the pure storage-consistency property.
  // ─────────────────────────────────────────────────────────────────────────
  describe("UTC storage consistency across timezones", () => {
    const nowMs = Date.UTC(2025, 7, 20, 14, 30, 0, 0); // 2025-08-20T14:30:00Z

    const zones = [
      "UTC",
      "America/New_York",
      "America/Los_Angeles",
      "Europe/London",
      "Africa/Lagos",
      "Asia/Tokyo",        // UTC+9, never DST
      "Australia/Sydney",  // UTC+10/+11, DST in southern-hemisphere autumn/spring
    ];

    it("gracePeriodEndsAt is identical for all 7 server timezones", async () => {
      const results: number[] = [];

      for (const tz of zones) {
        jest.clearAllMocks();
        (prisma.applicant.findUnique as jest.Mock).mockResolvedValue(applicantMock);
        process.env.TZ = tz;
        jest.setSystemTime(nowMs);
        (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([overdueNoGrace(nowMs)]);
        await runRepaymentAudit();
        results.push(capturedDate("gracePeriodEndsAt").getTime());
      }

      const expected = nowMs + GRACE_MS;
      for (const r of results) {
        expect(r).toBe(expected);
      }
    });

    it("nextDueDate is identical for all 7 server timezones", async () => {
      const results: number[] = [];

      for (const tz of zones) {
        jest.clearAllMocks();
        (prisma.applicant.findUnique as jest.Mock).mockResolvedValue(applicantMock);
        process.env.TZ = tz;
        jest.setSystemTime(nowMs);
        (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([expiredGrace(nowMs)]);
        await runRepaymentAudit();
        results.push(capturedDate("dueDate").getTime());
      }

      const expected = nowMs + NEXT_DUE_MS;
      for (const r of results) {
        expect(r).toBe(expected);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 5 — Leap-year February 29 edge cases
  // ─────────────────────────────────────────────────────────────────────────
  describe("Leap-year February 29 edge cases", () => {
    // 2028 is the next leap year.

    it("grace period starting on Feb 29 (leap year 2028) ends on Mar 3", async () => {
      const nowMs = Date.UTC(2028, 1, 29, 0, 0, 0, 0);
      jest.setSystemTime(nowMs);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([overdueNoGrace(nowMs)]);

      await runRepaymentAudit();

      const stored = capturedDate("gracePeriodEndsAt");
      expect(stored.getTime()).toBe(nowMs + GRACE_MS);
      expect(stored.getUTCMonth()).toBe(2); // March (0-indexed)
      expect(stored.getUTCDate()).toBe(3);
    });

    it("nextDueDate starting on Feb 29 (2028) is Mar 30", async () => {
      const nowMs = Date.UTC(2028, 1, 29, 0, 0, 0, 0);
      jest.setSystemTime(nowMs);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([expiredGrace(nowMs)]);

      await runRepaymentAudit();

      const stored = capturedDate("dueDate");
      expect(stored.getTime()).toBe(nowMs + NEXT_DUE_MS);
      expect(stored.getUTCMonth()).toBe(2); // March
      expect(stored.getUTCDate()).toBe(30);
    });

    it("leap year Feb 28 + 3 days = Mar 2 (passes through Feb 29)", async () => {
      const nowMs = Date.UTC(2028, 1, 28, 0, 0, 0, 0);
      jest.setSystemTime(nowMs);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([overdueNoGrace(nowMs)]);

      await runRepaymentAudit();

      const stored = capturedDate("gracePeriodEndsAt");
      expect(stored.getTime()).toBe(nowMs + GRACE_MS);
      expect(stored.getUTCMonth()).toBe(2); // March
      expect(stored.getUTCDate()).toBe(2);
    });

    it("non-leap year Feb 28 + 3 days = Mar 3 (skips the non-existent Feb 29)", async () => {
      const nowMs = Date.UTC(2025, 1, 28, 0, 0, 0, 0);
      jest.setSystemTime(nowMs);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([overdueNoGrace(nowMs)]);

      await runRepaymentAudit();

      const stored = capturedDate("gracePeriodEndsAt");
      expect(stored.getTime()).toBe(nowMs + GRACE_MS);
      expect(stored.getUTCMonth()).toBe(2); // March
      expect(stored.getUTCDate()).toBe(3);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 6 — Month-length rollover edge cases
  // ─────────────────────────────────────────────────────────────────────────
  describe("Month-length rollover edge cases", () => {
    it("Jan 31 + 30 days = Mar 2 (non-leap year 2026)", async () => {
      const nowMs = Date.UTC(2026, 0, 31, 12, 0, 0, 0);
      jest.setSystemTime(nowMs);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([expiredGrace(nowMs)]);

      await runRepaymentAudit();

      const stored = capturedDate("dueDate");
      expect(stored.getTime()).toBe(nowMs + NEXT_DUE_MS);
      expect(stored.getUTCMonth()).toBe(2); // March
      expect(stored.getUTCDate()).toBe(2);
    });

    it("Feb 28 (non-leap) + 30 days = Mar 30", async () => {
      const nowMs = Date.UTC(2025, 1, 28, 0, 0, 0, 0);
      jest.setSystemTime(nowMs);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([expiredGrace(nowMs)]);

      await runRepaymentAudit();

      const stored = capturedDate("dueDate");
      expect(stored.getTime()).toBe(nowMs + NEXT_DUE_MS);
      expect(stored.getUTCMonth()).toBe(2); // March
      expect(stored.getUTCDate()).toBe(30);
    });

    it("Oct 31 + 30 days = Nov 30 (not Dec 1)", async () => {
      const nowMs = Date.UTC(2025, 9, 31, 0, 0, 0, 0);
      jest.setSystemTime(nowMs);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([expiredGrace(nowMs)]);

      await runRepaymentAudit();

      const stored = capturedDate("dueDate");
      expect(stored.getTime()).toBe(nowMs + NEXT_DUE_MS);
      expect(stored.getUTCMonth()).toBe(10); // November
      expect(stored.getUTCDate()).toBe(30);
    });

    it("Mar 31 + 30 days = Apr 30 (not May 1)", async () => {
      const nowMs = Date.UTC(2025, 2, 31, 0, 0, 0, 0);
      jest.setSystemTime(nowMs);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([expiredGrace(nowMs)]);

      await runRepaymentAudit();

      const stored = capturedDate("dueDate");
      expect(stored.getTime()).toBe(nowMs + NEXT_DUE_MS);
      expect(stored.getUTCMonth()).toBe(3); // April
      expect(stored.getUTCDate()).toBe(30);
    });

    it("Dec 31 + 30 days rolls into Jan 30 of the following year", async () => {
      const nowMs = Date.UTC(2025, 11, 31, 0, 0, 0, 0);
      jest.setSystemTime(nowMs);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([expiredGrace(nowMs)]);

      await runRepaymentAudit();

      const stored = capturedDate("dueDate");
      expect(stored.getTime()).toBe(nowMs + NEXT_DUE_MS);
      expect(stored.getUTCFullYear()).toBe(2026);
      expect(stored.getUTCMonth()).toBe(0); // January
      expect(stored.getUTCDate()).toBe(30);
    });

    it("Dec 31 + 3-day grace period ends on Jan 3 of the following year", async () => {
      const nowMs = Date.UTC(2025, 11, 31, 0, 0, 0, 0);
      jest.setSystemTime(nowMs);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([overdueNoGrace(nowMs)]);

      await runRepaymentAudit();

      const stored = capturedDate("gracePeriodEndsAt");
      expect(stored.getTime()).toBe(nowMs + GRACE_MS);
      expect(stored.getUTCFullYear()).toBe(2026);
      expect(stored.getUTCMonth()).toBe(0); // January
      expect(stored.getUTCDate()).toBe(3);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 7 — Off-by-one-day boundary protection
  // ─────────────────────────────────────────────────────────────────────────
  describe("Off-by-one-day boundary protection", () => {
    const dueDate   = new Date(Date.UTC(2026, 5, 1, 0, 0, 0, 0)); // 2026-06-01T00:00:00Z
    const graceEndsAt = new Date(Date.UTC(2026, 5, 4, 0, 0, 0, 0)); // 2026-06-04T00:00:00Z

    it("1 ms before dueDate: audit does NOT enter grace period", async () => {
      jest.setSystemTime(dueDate.getTime() - 1);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
        { id: "loan-b", applicantId: "applicant-dst", status: "ACTIVE",
          dueDate, gracePeriodEndsAt: null, missedPayments: 0, lateFeeBalance: 0 },
      ]);

      await runRepaymentAudit();

      const calls = (prisma.loanApplication.update as jest.Mock).mock.calls;
      expect(calls.filter(([a]) => "gracePeriodEndsAt" in (a?.data ?? {}))).toHaveLength(0);
    });

    it("1 ms after dueDate: audit enters grace period", async () => {
      jest.setSystemTime(dueDate.getTime() + 1);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
        { id: "loan-b", applicantId: "applicant-dst", status: "ACTIVE",
          dueDate, gracePeriodEndsAt: null, missedPayments: 0, lateFeeBalance: 0 },
      ]);

      await runRepaymentAudit();

      expect(prisma.loanApplication.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ gracePeriodEndsAt: expect.any(Date) }) })
      );
    });

    it("1 ms before gracePeriodEndsAt: missed payment is NOT recorded", async () => {
      jest.setSystemTime(graceEndsAt.getTime() - 1);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
        { id: "loan-gb", applicantId: "applicant-dst", status: "ACTIVE",
          dueDate: new Date(dueDate.getTime() - 1000), gracePeriodEndsAt: graceEndsAt,
          missedPayments: 0, lateFeeBalance: 0 },
      ]);

      await runRepaymentAudit();

      const calls = (prisma.loanApplication.update as jest.Mock).mock.calls;
      expect(calls.filter(([a]) => "missedPayments" in (a?.data ?? {}))).toHaveLength(0);
    });

    it("1 ms after gracePeriodEndsAt: missed payment IS recorded", async () => {
      jest.setSystemTime(graceEndsAt.getTime() + 1);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
        { id: "loan-gb", applicantId: "applicant-dst", status: "ACTIVE",
          dueDate: new Date(dueDate.getTime() - 1000), gracePeriodEndsAt: graceEndsAt,
          missedPayments: 0, lateFeeBalance: 0 },
      ]);

      await runRepaymentAudit();

      expect(prisma.loanApplication.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ missedPayments: 1 }) })
      );
    });

    // This test uses a now that crosses a DST fall-back so setDate and setUTCDate
    // diverge, then asserts the exact ms offset is 72 h (not 73 h).
    it("gracePeriodEndsAt offset is exactly 259200000 ms — not 73 h across fall-back", async () => {
      const nowMs = Date.UTC(2025, 9, 30, 22, 0, 0, 0); // Crosses US fall-back when +3 days
      process.env.TZ = "America/New_York";
      jest.setSystemTime(nowMs);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([overdueNoGrace(nowMs)]);

      await runRepaymentAudit();

      const diff = capturedDate("gracePeriodEndsAt").getTime() - nowMs;
      expect(diff).toBe(GRACE_MS);
      expect(diff).not.toBe(73 * 3600 * 1000);
    });

    // Same for spring-forward: 72 h, not 71 h.
    it("gracePeriodEndsAt offset is exactly 259200000 ms — not 71 h across spring-forward", async () => {
      const nowMs = Date.UTC(2025, 2, 7, 22, 0, 0, 0); // Crosses US spring-forward when +3 days
      process.env.TZ = "America/New_York";
      jest.setSystemTime(nowMs);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([overdueNoGrace(nowMs)]);

      await runRepaymentAudit();

      const diff = capturedDate("gracePeriodEndsAt").getTime() - nowMs;
      expect(diff).toBe(GRACE_MS);
      expect(diff).not.toBe(71 * 3600 * 1000);
    });

    // nextDueDate: exactly 30×24 h, not 29 or 31 days, across a fall-back.
    it("nextDueDate is exactly 2592000000 ms — not 29 or 31 days across fall-back", async () => {
      const nowMs = Date.UTC(2025, 9, 3, 22, 0, 0, 0); // Oct 3, +30 days = Nov 2 (past fall-back)
      process.env.TZ = "America/New_York";
      jest.setSystemTime(nowMs);
      (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([expiredGrace(nowMs)]);

      await runRepaymentAudit();

      const diff = capturedDate("dueDate").getTime() - nowMs;
      expect(diff).toBe(NEXT_DUE_MS);
      expect(diff).not.toBe(29 * 24 * 3600 * 1000);
      expect(diff).not.toBe(31 * 24 * 3600 * 1000);
    });
  });
});
