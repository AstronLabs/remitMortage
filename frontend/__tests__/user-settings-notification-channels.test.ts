/**
 * @jest-environment node
 */
import { GET, POST } from "../src/app/api/user/settings/route";
import { CHANNEL_EVENT_TYPES } from "../src/lib/notificationChannels";

function postRequest(body: unknown): any {
  return new Request("http://localhost/api/user/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getRequest(userId: string): any {
  return new Request(`http://localhost/api/user/settings?userId=${encodeURIComponent(userId)}`);
}

describe("per-event notification channels in /api/user/settings", () => {
  it("defaults every event type to the existing global default (email only)", async () => {
    const res = await GET(getRequest("channels-new-user") as any);
    const { settings } = await res.json();
    for (const type of CHANNEL_EVENT_TYPES) {
      expect(settings.notifications.eventChannels[type]).toEqual(["email"]);
    }
    expect(settings.notifications.emailAlerts).toBe(true);
    expect(settings.notifications.smsAlerts).toBe(false);
  });

  it("preserves an existing user's global choice when they save without per-type channels", async () => {
    const userId = "channels-legacy-user";
    await POST(postRequest({ userId, notifications: { emailAlerts: true, smsAlerts: true } }) as any);

    const { settings } = await (await GET(getRequest(userId) as any)).json();
    for (const type of CHANNEL_EVENT_TYPES) {
      expect(settings.notifications.eventChannels[type]).toEqual(["email", "sms"]);
    }
    expect(settings.notifications.emailAlerts).toBe(true);
    expect(settings.notifications.smsAlerts).toBe(true);
  });

  it("stores different channels for different event types, including multiple for one", async () => {
    const userId = "channels-override-user";
    await POST(
      postRequest({
        userId,
        notifications: {
          emailAlerts: true,
          smsAlerts: false,
          eventChannels: { paymentMissed: ["email", "sms"], governanceAlerts: ["email"], loanApproval: [] },
        },
      }) as any
    );

    const { settings } = await (await GET(getRequest(userId) as any)).json();
    expect(settings.notifications.eventChannels.paymentMissed).toEqual(["email", "sms"]);
    expect(settings.notifications.eventChannels.governanceAlerts).toEqual(["email"]);
    expect(settings.notifications.eventChannels.loanApproval).toEqual([]);
    // Unspecified types keep the global choice.
    expect(settings.notifications.eventChannels.escrowReached).toEqual(["email"]);
    // Legacy flags reflect any channel still in use.
    expect(settings.notifications.smsAlerts).toBe(true);
  });

  it("rejects an invalid eventChannels payload", async () => {
    const res = await POST(
      postRequest({ userId: "channels-invalid-user", notifications: { eventChannels: { paymentMissed: ["fax"] } } }) as any
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_event_channels");
  });
});
