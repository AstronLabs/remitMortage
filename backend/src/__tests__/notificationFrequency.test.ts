import { prisma, getNotificationPreference } from "../services/db.js";
import { dispatchMaturityAlerts } from "../services/notification.js";

jest.mock("../services/db.js", () => ({
  prisma: {
    notification: {
      create: jest.fn(),
    },
  },
  getNotificationPreference: jest.fn(),
}));

// The BullMQ enqueue in queueNotification is fire-and-forget from
// dispatchMaturityAlerts' perspective (wrapped in Promise.allSettled), so it
// doesn't need mocking for these tests — only the Prisma create call (and
// the exact delay baked into its `nextRetryAt`) matters here.

const ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function basePreferences(overrides: Record<string, unknown> = {}) {
  return {
    email: "borrower@example.com",
    phone: "+15550001111",
    emailAlerts: true,
    smsAlerts: false,
    escrowApproaching: true,
    escrowReached: true,
    paymentMissed: true,
    loanMilestones: true,
    governanceAlerts: true,
    webhookUrl: null,
    depositsFrequency: "IMMEDIATE",
    milestonesFrequency: "IMMEDIATE",
    governanceFrequency: "IMMEDIATE",
    ...overrides,
  };
}

function lastCreateData() {
  return (prisma.notification.create as jest.Mock).mock.calls.at(-1)?.[0].data;
}

describe("dispatchMaturityAlerts — frequency-aware delivery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.notification.create as jest.Mock).mockResolvedValue({ id: "notif-1" });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("delivers immediately (no nextRetryAt) when a category's frequency is IMMEDIATE", async () => {
    (getNotificationPreference as jest.Mock).mockResolvedValue(
      basePreferences({ depositsFrequency: "IMMEDIATE" })
    );

    await dispatchMaturityAlerts(ADDRESS, {
      type: "ESCROW_APPROACHING",
      progress: 80,
      deposited: "2400",
      target: "3000",
    });

    expect(lastCreateData().nextRetryAt).toBeUndefined();
  });

  it("defers a deposits-category alert to the next daily digest window", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-05T10:00:00.000Z")); // Monday 10:00 UTC

    (getNotificationPreference as jest.Mock).mockResolvedValue(
      basePreferences({ depositsFrequency: "DAILY_DIGEST", timezone: "UTC", startHour: "09:00" })
    );

    await dispatchMaturityAlerts(ADDRESS, {
      type: "ESCROW_REACHED",
      deposited: "3000",
      target: "3000",
    });

    expect(lastCreateData().nextRetryAt).toEqual(new Date("2026-01-06T09:00:00.000Z"));
  });

  it("defers a milestones-category alert to the next weekly digest window", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-05T10:00:00.000Z")); // Monday 10:00 UTC, past 09:00

    (getNotificationPreference as jest.Mock).mockResolvedValue(
      basePreferences({ milestonesFrequency: "WEEKLY_DIGEST", timezone: "UTC", startHour: "09:00" })
    );

    await dispatchMaturityAlerts(ADDRESS, {
      type: "MILESTONE_UPDATE",
      milestoneName: "Foundation",
    });

    expect(lastCreateData().nextRetryAt).toEqual(new Date("2026-01-12T09:00:00.000Z"));
  });

  it("reflects a changed governance preference on the very next dispatch", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-05T10:00:00.000Z"));

    // First: IMMEDIATE.
    (getNotificationPreference as jest.Mock).mockResolvedValue(
      basePreferences({ governanceFrequency: "IMMEDIATE" })
    );
    await dispatchMaturityAlerts(ADDRESS, { type: "GOVERNANCE_PROPOSAL", message: "Proposal #1" });
    expect(lastCreateData().nextRetryAt).toBeUndefined();

    // User changes the preference to WEEKLY_DIGEST — the very next matching
    // event must honor it without any other code change.
    (getNotificationPreference as jest.Mock).mockResolvedValue(
      basePreferences({ governanceFrequency: "WEEKLY_DIGEST", timezone: "UTC", startHour: "09:00" })
    );
    await dispatchMaturityAlerts(ADDRESS, { type: "GOVERNANCE_PROPOSAL", message: "Proposal #2" });
    expect(lastCreateData().nextRetryAt).toEqual(new Date("2026-01-12T09:00:00.000Z"));
  });

  it("does not send a governance alert when governanceAlerts is disabled, regardless of frequency", async () => {
    (getNotificationPreference as jest.Mock).mockResolvedValue(
      basePreferences({ governanceAlerts: false, governanceFrequency: "IMMEDIATE" })
    );

    await dispatchMaturityAlerts(ADDRESS, { type: "GOVERNANCE_PROPOSAL", message: "Proposal #3" });

    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  describe("security alerts are never deferred", () => {
    it("delivers a SECURITY_ALERT immediately even when every category prefers a weekly digest", async () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-01-05T10:00:00.000Z"));

      (getNotificationPreference as jest.Mock).mockResolvedValue(
        basePreferences({
          depositsFrequency: "WEEKLY_DIGEST",
          milestonesFrequency: "WEEKLY_DIGEST",
          governanceFrequency: "WEEKLY_DIGEST",
          timezone: "UTC",
          startHour: "09:00",
        })
      );

      await dispatchMaturityAlerts(ADDRESS, {
        type: "SECURITY_ALERT",
        message: "New sign-in from an unrecognized device",
      });

      expect(lastCreateData().nextRetryAt).toBeUndefined();
      expect(lastCreateData().content).toContain("Security Alert");
    });

    it("bypasses business-hours throttling too, unlike a comparable non-urgent alert", async () => {
      // 02:00 UTC local time, outside the 09:00-17:00 business-hours window —
      // a normal IMMEDIATE-frequency, non-urgent alert would be pushed out to
      // the next business day by computeBusinessHoursDelay.
      jest.useFakeTimers().setSystemTime(new Date("2026-01-05T02:00:00.000Z"));

      const prefs = basePreferences({ timezone: "UTC", startHour: "09:00", endHour: "17:00" });
      (getNotificationPreference as jest.Mock).mockResolvedValue(prefs);

      await dispatchMaturityAlerts(ADDRESS, {
        type: "ESCROW_APPROACHING",
        progress: 50,
        deposited: "1500",
        target: "3000",
      });
      const deferredAlertData = lastCreateData();
      expect(deferredAlertData.nextRetryAt).toBeInstanceOf(Date);
      expect(deferredAlertData.nextRetryAt.getTime()).toBeGreaterThan(Date.now());

      // Same clock, same preferences — but a security alert still ships now.
      await dispatchMaturityAlerts(ADDRESS, {
        type: "SECURITY_ALERT",
        message: "Password changed",
      });
      expect(lastCreateData().nextRetryAt).toBeUndefined();
    });

    it("cannot be silenced — SECURITY_ALERT always sends even though there is no enable/disable preference for it", async () => {
      (getNotificationPreference as jest.Mock).mockResolvedValue(basePreferences());

      await dispatchMaturityAlerts(ADDRESS, { type: "SECURITY_ALERT", message: "New API key created" });

      expect(prisma.notification.create).toHaveBeenCalled();
    });
  });
});
