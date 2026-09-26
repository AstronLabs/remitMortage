/**
 * @jest-environment node
 */
import { GET, POST } from "../src/app/api/user/settings/route";

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

describe("GET /api/user/settings — notification frequency defaults", () => {
  it("defaults every category to IMMEDIATE and never exposes a securityFrequency", async () => {
    const res = await GET(getRequest("brand-new-user-1") as any);
    const body = await res.json();

    expect(body.settings.notifications).toMatchObject({
      depositsFrequency: "IMMEDIATE",
      milestonesFrequency: "IMMEDIATE",
      governanceFrequency: "IMMEDIATE",
    });
    expect(body.settings.notifications).not.toHaveProperty("securityFrequency");
  });
});

describe("POST /api/user/settings — per-category frequency persistence", () => {
  it("changing a category's frequency is reflected on the next fetch", async () => {
    const userId = "frequency-persistence-user";

    await POST(
      postRequest({
        userId,
        notifications: {
          depositsFrequency: "DAILY_DIGEST",
          milestonesFrequency: "WEEKLY_DIGEST",
          governanceFrequency: "IMMEDIATE",
        },
      }) as any
    );

    const res = await GET(getRequest(userId) as any);
    const body = await res.json();

    expect(body.settings.notifications.depositsFrequency).toBe("DAILY_DIGEST");
    expect(body.settings.notifications.milestonesFrequency).toBe("WEEKLY_DIGEST");
    expect(body.settings.notifications.governanceFrequency).toBe("IMMEDIATE");
  });

  it.each(["depositsFrequency", "milestonesFrequency", "governanceFrequency"])(
    "rejects an invalid value for %s",
    async (field) => {
      const res = await POST(
        postRequest({ userId: "invalid-frequency-user", notifications: { [field]: "HOURLY" } }) as any
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("invalid_frequency");
      expect(body.field).toBe(field);
    }
  );

  describe("the non-overridable security-alert exception", () => {
    it("rejects any request that includes a securityFrequency field", async () => {
      const res = await POST(
        postRequest({
          userId: "security-attempt-user",
          notifications: { securityFrequency: "WEEKLY_DIGEST" },
        }) as any
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("security_frequency_not_configurable");
    });

    it("does not persist any change when securityFrequency is present, even alongside valid fields", async () => {
      const userId = "security-attempt-bundled-user";

      await POST(
        postRequest({
          userId,
          notifications: { depositsFrequency: "DAILY_DIGEST", securityFrequency: "IMMEDIATE" },
        }) as any
      );

      const res = await GET(getRequest(userId) as any);
      const body = await res.json();
      // Falls through to the default (IMMEDIATE), proving the DAILY_DIGEST
      // part of the rejected request was never saved.
      expect(body.settings.notifications.depositsFrequency).toBe("IMMEDIATE");
    });
  });
});
