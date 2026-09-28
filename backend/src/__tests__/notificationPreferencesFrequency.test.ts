import express from "express";
import request from "supertest";
import { notificationsRouter } from "../routes/notifications.js";
import { upsertNotificationPreference, getNotificationPreference } from "../services/db.js";

jest.mock("../services/db.js", () => ({
  getNotificationPreference: jest.fn(),
  upsertNotificationPreference: jest.fn(),
  getUserInAppNotifications: jest.fn(),
  markInAppNotificationRead: jest.fn(),
  markAllInAppNotificationsRead: jest.fn(),
  createInAppNotification: jest.fn(),
}));

const TEST_WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const app = express();
app.use(express.json());
app.use("/api/notifications", notificationsRouter);

describe("POST /api/notifications/preferences — per-category frequency", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (upsertNotificationPreference as jest.Mock).mockImplementation((_id, data) =>
      Promise.resolve({ applicantId: "applicant-1", ...data })
    );
  });

  it("persists valid per-category frequency preferences", async () => {
    const res = await request(app)
      .post("/api/notifications/preferences")
      .send({
        address: TEST_WALLET,
        depositsFrequency: "DAILY_DIGEST",
        milestonesFrequency: "WEEKLY_DIGEST",
        governanceFrequency: "IMMEDIATE",
      });

    expect(res.status).toBe(200);
    expect(upsertNotificationPreference).toHaveBeenCalledWith(
      TEST_WALLET,
      expect.objectContaining({
        depositsFrequency: "DAILY_DIGEST",
        milestonesFrequency: "WEEKLY_DIGEST",
        governanceFrequency: "IMMEDIATE",
      })
    );
    expect(res.body.preferences.depositsFrequency).toBe("DAILY_DIGEST");
  });

  it.each(["depositsFrequency", "milestonesFrequency", "governanceFrequency"])(
    "rejects an invalid value for %s",
    async (field) => {
      const res = await request(app)
        .post("/api/notifications/preferences")
        .send({ address: TEST_WALLET, [field]: "HOURLY" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_frequency");
      expect(res.body.field).toBe(field);
      expect(upsertNotificationPreference).not.toHaveBeenCalled();
    }
  );

  it("leaves unspecified frequency fields untouched rather than forcing a default", async () => {
    await request(app)
      .post("/api/notifications/preferences")
      .send({ address: TEST_WALLET, depositsFrequency: "DAILY_DIGEST" });

    const [, data] = (upsertNotificationPreference as jest.Mock).mock.calls[0];
    expect(data).toHaveProperty("depositsFrequency", "DAILY_DIGEST");
    expect(data).not.toHaveProperty("milestonesFrequency");
    expect(data).not.toHaveProperty("governanceFrequency");
  });

  describe("the non-overridable security-alert exception", () => {
    it("rejects any request that attempts to set a security frequency", async () => {
      const res = await request(app)
        .post("/api/notifications/preferences")
        .send({ address: TEST_WALLET, securityFrequency: "WEEKLY_DIGEST" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("security_frequency_not_configurable");
      expect(upsertNotificationPreference).not.toHaveBeenCalled();
    });

    it("rejects it even when bundled with otherwise-valid preference changes", async () => {
      const res = await request(app)
        .post("/api/notifications/preferences")
        .send({
          address: TEST_WALLET,
          depositsFrequency: "DAILY_DIGEST",
          securityFrequency: "IMMEDIATE", // even the "no-op" value is rejected — the field itself isn't allowed
        });

      expect(res.status).toBe(400);
      expect(upsertNotificationPreference).not.toHaveBeenCalled();
    });

    it("never returns a security frequency in the fetched preferences, since none is ever persisted", async () => {
      (getNotificationPreference as jest.Mock).mockResolvedValue({
        applicantId: "applicant-1",
        depositsFrequency: "IMMEDIATE",
        milestonesFrequency: "IMMEDIATE",
        governanceFrequency: "IMMEDIATE",
      });

      const res = await request(app).get(`/api/notifications/preferences?address=${TEST_WALLET}`);

      expect(res.status).toBe(200);
      expect(res.body.preferences).not.toHaveProperty("securityFrequency");
    });
  });
});
