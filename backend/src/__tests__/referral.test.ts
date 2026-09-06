jest.mock("../services/db.js", () => ({
  prisma: {
    referralCode: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    referralAttribution: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    applicant: {
      findMany: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
  },
}));

import express from "express";
import request from "supertest";
import { referralRouter } from "../routes/referral";
import { prisma } from "../services/db.js";

const app = express();
app.use(express.json());
app.use("/api/referral", referralRouter);

const OWNER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const REFERRED = "GDV54EKM5R5VUQMLNKU4C753WABOVUQ5Y33A4BKIVEK5PP3PSV4B4ONY";

describe("Referral API routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("creates a referral code and invite link for an owner address", async () => {
    (prisma.referralCode.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.referralCode.create as jest.Mock).mockResolvedValue({
      code: "RM-ABCDEF12",
      ownerAddress: OWNER,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const res = await request(app).get(`/api/referral/code?ownerAddress=${OWNER}`);
    expect(res.status).toBe(200);
    expect(res.body.code).toBe("RM-ABCDEF12");
    expect(res.body.inviteLink).toContain("/onboarding?ref=RM-ABCDEF12");
  });

  it("attributes a referred wallet to the referral code owner", async () => {
    (prisma.referralCode.findUnique as jest.Mock).mockResolvedValue({
      id: "ref-1",
      code: "RM-ABCDEF12",
      ownerAddress: OWNER,
    });
    (prisma.referralAttribution.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.referralAttribution.create as jest.Mock).mockResolvedValue({ id: "attr-1" });
    (prisma.auditLog.create as jest.Mock).mockResolvedValue({});

    const res = await request(app)
      .post("/api/referral/attribute")
      .send({ code: "rm-abcdef12", referredAddress: REFERRED });

    expect(res.status).toBe(201);
    expect(res.body.attributionId).toBe("attr-1");
  });

  it("returns referral stats with invite and conversion counts", async () => {
    (prisma.referralCode.findUnique as jest.Mock).mockResolvedValue({
      code: "RM-ABCDEF12",
      ownerAddress: OWNER,
      attributions: [
        { referredAddress: REFERRED, createdAt: new Date("2026-01-02T00:00:00.000Z") },
      ],
    });
    (prisma.applicant.findMany as jest.Mock).mockResolvedValue([{ stellarAddress: REFERRED }]);

    const res = await request(app).get(`/api/referral/stats?ownerAddress=${OWNER}`);
    expect(res.status).toBe(200);
    expect(res.body.invitesSent).toBe(1);
    expect(res.body.conversions).toBe(1);
  });
});
