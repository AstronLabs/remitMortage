import express from "express";
import request from "supertest";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { userRouter } from "../routes/user";
import { getCommunicationPreferences, updateCommunicationPreferences } from "../services/communicationPreferences";

jest.mock("../services/db.js", () => ({
  getUserDataExport: jest.fn(),
  processUserDataDeletion: jest.fn(),
}));

jest.mock("../services/communicationPreferences.js", () => {
  const actual = jest.requireActual("../services/communicationPreferences.js");
  return {
    ...actual,
    getCommunicationPreferences: jest.fn(),
    updateCommunicationPreferences: jest.fn(),
  };
});

const JWT_SECRET = process.env.JWT_SECRET || "default_jwt_secret";
const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function authCookie() {
  const token = jwt.sign({ walletAddress: WALLET, network: "testnet" }, JWT_SECRET, { expiresIn: "24h" });
  return `token=${token}`;
}

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/user", userRouter);

function fullMatrixFixture() {
  const categories = ["DEPOSITS", "MILESTONES", "GOVERNANCE", "SECURITY"] as const;
  const channels = ["EMAIL", "SMS", "PUSH"] as const;
  const matrix: any = {};
  for (const category of categories) {
    matrix[category] = {};
    for (const channel of channels) {
      matrix[category][channel] = {
        enabled: channel !== "SMS",
        consentTimestamp: null,
        consentSource: null,
      };
    }
  }
  return matrix;
}

describe("GET /api/user/communication-preferences", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await request(app).get("/api/user/communication-preferences");
    expect(res.status).toBe(401);
    expect(getCommunicationPreferences).not.toHaveBeenCalled();
  });

  it("returns the caller's own matrix, scoped by their authenticated wallet", async () => {
    (getCommunicationPreferences as jest.Mock).mockResolvedValue(fullMatrixFixture());

    const res = await request(app).get("/api/user/communication-preferences").set("Cookie", [authCookie()]);

    expect(res.status).toBe(200);
    expect(getCommunicationPreferences).toHaveBeenCalledWith(WALLET);
    expect(res.body.preferences.DEPOSITS.EMAIL.enabled).toBe(true);
    expect(res.body.preferences.DEPOSITS.SMS.enabled).toBe(false);
  });
});

describe("PUT /api/user/communication-preferences", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (updateCommunicationPreferences as jest.Mock).mockResolvedValue(fullMatrixFixture());
  });

  it("rejects an unauthenticated request", async () => {
    const res = await request(app)
      .put("/api/user/communication-preferences")
      .send({ updates: [{ category: "DEPOSITS", channel: "SMS", enabled: true }] });
    expect(res.status).toBe(401);
    expect(updateCommunicationPreferences).not.toHaveBeenCalled();
  });

  it("rejects a missing or empty updates array", async () => {
    const res = await request(app)
      .put("/api/user/communication-preferences")
      .set("Cookie", [authCookie()])
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("rejects an invalid category", async () => {
    const res = await request(app)
      .put("/api/user/communication-preferences")
      .set("Cookie", [authCookie()])
      .send({ updates: [{ category: "PAYMENTS", channel: "SMS", enabled: true }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_category");
  });

  it("rejects an invalid channel", async () => {
    const res = await request(app)
      .put("/api/user/communication-preferences")
      .set("Cookie", [authCookie()])
      .send({ updates: [{ category: "DEPOSITS", channel: "FAX", enabled: true }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_channel");
  });

  it("rejects a non-boolean enabled value", async () => {
    const res = await request(app)
      .put("/api/user/communication-preferences")
      .set("Cookie", [authCookie()])
      .send({ updates: [{ category: "DEPOSITS", channel: "SMS", enabled: "yes" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_enabled");
  });

  it("persists a valid update, scoped to the authenticated wallet", async () => {
    const res = await request(app)
      .put("/api/user/communication-preferences")
      .set("Cookie", [authCookie()])
      .send({ updates: [{ category: "DEPOSITS", channel: "SMS", enabled: true, source: "settings_page" }] });

    expect(res.status).toBe(200);
    expect(updateCommunicationPreferences).toHaveBeenCalledWith(WALLET, [
      { category: "DEPOSITS", channel: "SMS", enabled: true, source: "settings_page" },
    ]);
  });

  describe("the security category's non-overridable email channel", () => {
    it("rejects an attempt to disable SECURITY/EMAIL", async () => {
      const res = await request(app)
        .put("/api/user/communication-preferences")
        .set("Cookie", [authCookie()])
        .send({ updates: [{ category: "SECURITY", channel: "EMAIL", enabled: false }] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("security_email_required");
      expect(updateCommunicationPreferences).not.toHaveBeenCalled();
    });

    it("still allows disabling SECURITY/SMS and SECURITY/PUSH", async () => {
      const res = await request(app)
        .put("/api/user/communication-preferences")
        .set("Cookie", [authCookie()])
        .send({
          updates: [
            { category: "SECURITY", channel: "SMS", enabled: false },
            { category: "SECURITY", channel: "PUSH", enabled: false },
          ],
        });

      expect(res.status).toBe(200);
      expect(updateCommunicationPreferences).toHaveBeenCalled();
    });

    it("rejects the whole batch when SECURITY/EMAIL=false is bundled with otherwise-valid updates", async () => {
      const res = await request(app)
        .put("/api/user/communication-preferences")
        .set("Cookie", [authCookie()])
        .send({
          updates: [
            { category: "DEPOSITS", channel: "SMS", enabled: true },
            { category: "SECURITY", channel: "EMAIL", enabled: false },
          ],
        });

      expect(res.status).toBe(400);
      expect(updateCommunicationPreferences).not.toHaveBeenCalled();
    });
  });
});
