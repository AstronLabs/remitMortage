import { prisma, getNotificationPreference } from "../services/db.js";
import { getCommunicationPreferences } from "../services/communicationPreferences.js";
import { dispatchMaturityAlerts } from "../services/notification.js";

jest.mock("../services/db.js", () => ({
  prisma: {
    notification: {
      create: jest.fn(),
    },
  },
  getNotificationPreference: jest.fn(),
}));

jest.mock("../services/communicationPreferences.js", () => ({
  getCommunicationPreferences: jest.fn(),
}));

const ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function legacyPreferences(overrides: Record<string, unknown> = {}) {
  return {
    email: "borrower@example.com",
    phone: "+15550001111",
    emailAlerts: true,
    smsAlerts: true,
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

/** A full opt-in matrix cell for every category/channel, all enabled by default. */
function fullMatrix(overrides: Partial<Record<string, Partial<Record<string, boolean>>>> = {}) {
  const categories = ["DEPOSITS", "MILESTONES", "GOVERNANCE", "SECURITY"];
  const channels = ["EMAIL", "SMS", "PUSH"];
  const matrix: any = {};
  for (const category of categories) {
    matrix[category] = {};
    for (const channel of channels) {
      const enabled = overrides[category]?.[channel] ?? true;
      matrix[category][channel] = { enabled, consentTimestamp: null, consentSource: null };
    }
  }
  return matrix;
}

function dispatchedTypes() {
  return (prisma.notification.create as jest.Mock).mock.calls.map((call) => call[0].data.type);
}

describe("dispatchMaturityAlerts — per-category channel gating", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.notification.create as jest.Mock).mockResolvedValue({ id: "notif-1" });
  });

  it("dispatches all three channels when a category's matrix has everything enabled", async () => {
    (getNotificationPreference as jest.Mock).mockResolvedValue(legacyPreferences());
    (getCommunicationPreferences as jest.Mock).mockResolvedValue(fullMatrix());

    await dispatchMaturityAlerts(ADDRESS, {
      type: "ESCROW_APPROACHING",
      progress: 80,
      deposited: "2400",
      target: "3000",
    });

    expect(dispatchedTypes().sort()).toEqual(["EMAIL", "PUSH", "SMS"]);
  });

  it("disabling SMS for a category stops SMS while email and push continue", async () => {
    (getNotificationPreference as jest.Mock).mockResolvedValue(legacyPreferences());
    (getCommunicationPreferences as jest.Mock).mockResolvedValue(
      fullMatrix({ DEPOSITS: { SMS: false } })
    );

    await dispatchMaturityAlerts(ADDRESS, {
      type: "ESCROW_REACHED",
      deposited: "3000",
      target: "3000",
    });

    const types = dispatchedTypes();
    expect(types).not.toContain("SMS");
    expect(types).toEqual(expect.arrayContaining(["EMAIL", "PUSH"]));
  });

  it("disabling SMS for one category doesn't affect SMS for another category", async () => {
    (getNotificationPreference as jest.Mock).mockResolvedValue(legacyPreferences());
    (getCommunicationPreferences as jest.Mock).mockResolvedValue(
      fullMatrix({ DEPOSITS: { SMS: false } })
    );

    await dispatchMaturityAlerts(ADDRESS, { type: "MILESTONE_UPDATE", milestoneName: "Foundation" });

    // MILESTONES.SMS is untouched by the DEPOSITS override above.
    expect(dispatchedTypes()).toContain("SMS");
  });

  it("disabling email for a category still allows SMS and push through", async () => {
    (getNotificationPreference as jest.Mock).mockResolvedValue(legacyPreferences());
    (getCommunicationPreferences as jest.Mock).mockResolvedValue(
      fullMatrix({ GOVERNANCE: { EMAIL: false } })
    );

    await dispatchMaturityAlerts(ADDRESS, { type: "GOVERNANCE_PROPOSAL", message: "Proposal #1" });

    const types = dispatchedTypes();
    expect(types).not.toContain("EMAIL");
    expect(types).toEqual(expect.arrayContaining(["SMS", "PUSH"]));
  });

  it("disabling every channel for a category results in no dispatch attempts at all", async () => {
    (getNotificationPreference as jest.Mock).mockResolvedValue(legacyPreferences());
    (getCommunicationPreferences as jest.Mock).mockResolvedValue(
      fullMatrix({ MILESTONES: { EMAIL: false, SMS: false, PUSH: false } })
    );

    await dispatchMaturityAlerts(ADDRESS, { type: "MILESTONE_UPDATE", milestoneName: "Roofing" });

    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it("still requires the legacy per-channel contact info (email/phone) even when the matrix allows it", async () => {
    (getNotificationPreference as jest.Mock).mockResolvedValue(legacyPreferences({ phone: null }));
    (getCommunicationPreferences as jest.Mock).mockResolvedValue(fullMatrix());

    await dispatchMaturityAlerts(ADDRESS, { type: "ESCROW_APPROACHING", progress: 50, deposited: "1500", target: "3000" });

    // Matrix says SMS is enabled, but there's no phone number to send to.
    expect(dispatchedTypes()).not.toContain("SMS");
  });

  it("falls back to the legacy emailAlerts/smsAlerts toggles for an uncategorized event type (PAYMENT_MISSED)", async () => {
    (getNotificationPreference as jest.Mock).mockResolvedValue(
      legacyPreferences({ emailAlerts: true, smsAlerts: false })
    );

    await dispatchMaturityAlerts(ADDRESS, { type: "PAYMENT_MISSED" });

    // getCommunicationPreferences must never even be consulted for this event type.
    expect(getCommunicationPreferences).not.toHaveBeenCalled();
    const types = dispatchedTypes();
    expect(types).toContain("EMAIL");
    expect(types).not.toContain("SMS");
    expect(types).not.toContain("PUSH");
  });

  it("SECURITY category dispatches through email even though it's the one channel that can never be turned off", async () => {
    (getNotificationPreference as jest.Mock).mockResolvedValue(legacyPreferences());
    (getCommunicationPreferences as jest.Mock).mockResolvedValue(
      fullMatrix({ SECURITY: { SMS: false, PUSH: false } })
    );

    await dispatchMaturityAlerts(ADDRESS, { type: "SECURITY_ALERT", message: "New sign-in" });

    const types = dispatchedTypes();
    expect(types).toContain("EMAIL");
    expect(types).not.toContain("SMS");
    expect(types).not.toContain("PUSH");
  });
});
