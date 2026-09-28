import express from "express";
import request from "supertest";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { Keypair } from "@stellar/stellar-sdk";

const startImpersonationMock = jest.fn();
const endImpersonationMock = jest.fn();
const getImpersonationStatusMock = jest.fn();

jest.mock("../services/impersonation.js", () => ({
  IMPERSONATION_COOKIE: "impersonation_token",
  IMPERSONATION_SESSION_TTL_MS: 15 * 60 * 1000,
  startImpersonation: (...args: unknown[]) => startImpersonationMock(...args),
  endImpersonation: (...args: unknown[]) => endImpersonationMock(...args),
  getImpersonationStatus: (...args: unknown[]) => getImpersonationStatusMock(...args),
}));

jest.mock("../middleware/rateLimit.js", () => ({
  sensitiveRateLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

const findFirstMock = jest.fn();
jest.mock("../services/db.js", () => ({
  prisma: {
    impersonationSession: {
      findFirst: (...args: unknown[]) => findFirstMock(...args),
    },
  },
}));

import { impersonationRouter } from "../routes/impersonation";

const JWT_SECRET = process.env.JWT_SECRET || "default_jwt_secret";
const admin = Keypair.random();
const target = Keypair.random();
const ADMIN_ADDRESS = admin.publicKey();
const TARGET_ADDRESS = target.publicKey();

function adminCookie() {
  const token = jwt.sign({ walletAddress: ADMIN_ADDRESS, network: "testnet" }, JWT_SECRET, {
    expiresIn: "24h",
  });
  return `token=${token}`;
}

describe("impersonation routes", () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_WALLET_ADDRESS = ADMIN_ADDRESS;

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api/admin", impersonationRouter);
  });

  afterEach(() => {
    delete process.env.ADMIN_WALLET_ADDRESS;
  });

  describe("POST /api/admin/impersonate/start", () => {
    it("rejects an unauthenticated caller", async () => {
      const res = await request(app)
        .post("/api/admin/impersonate/start")
        .send({ targetWallet: TARGET_ADDRESS });

      expect(res.status).toBe(401);
      expect(startImpersonationMock).not.toHaveBeenCalled();
    });

    it("rejects a caller whose wallet is not the configured admin", async () => {
      const nonAdmin = Keypair.random();
      const token = jwt.sign({ walletAddress: nonAdmin.publicKey(), network: "testnet" }, JWT_SECRET, {
        expiresIn: "24h",
      });

      const res = await request(app)
        .post("/api/admin/impersonate/start")
        .set("Cookie", [`token=${token}`])
        .send({ targetWallet: TARGET_ADDRESS });

      expect(res.status).toBe(403);
      expect(startImpersonationMock).not.toHaveBeenCalled();
    });

    it("rejects a malformed target wallet", async () => {
      const res = await request(app)
        .post("/api/admin/impersonate/start")
        .set("Cookie", [adminCookie()])
        .send({ targetWallet: "not-a-wallet" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_address");
      expect(startImpersonationMock).not.toHaveBeenCalled();
    });

    it("rejects an admin trying to impersonate themselves", async () => {
      const res = await request(app)
        .post("/api/admin/impersonate/start")
        .set("Cookie", [adminCookie()])
        .send({ targetWallet: ADMIN_ADDRESS });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_target");
      expect(startImpersonationMock).not.toHaveBeenCalled();
    });

    it("starts a session, sets the impersonation cookie, and returns its expiry", async () => {
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      startImpersonationMock.mockResolvedValue({ token: "signed.jwt.token", sessionId: "s-1", expiresAt });

      const res = await request(app)
        .post("/api/admin/impersonate/start")
        .set("Cookie", [adminCookie()])
        .send({ targetWallet: TARGET_ADDRESS, reason: "ticket #9" });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        sessionId: "s-1",
        targetWallet: TARGET_ADDRESS,
        expiresAt: expiresAt.toISOString(),
      });
      expect(startImpersonationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          adminAddress: ADMIN_ADDRESS,
          targetAddress: TARGET_ADDRESS,
          reason: "ticket #9",
        })
      );

      const setCookie = res.headers["set-cookie"] as unknown as string[];
      expect(setCookie.some((c) => c.startsWith("impersonation_token=signed.jwt.token"))).toBe(true);
      expect(setCookie.some((c) => c.includes("HttpOnly"))).toBe(true);
    });
  });

  describe("POST /api/admin/impersonate/end", () => {
    it("rejects an unauthenticated caller", async () => {
      const res = await request(app).post("/api/admin/impersonate/end").send({});
      expect(res.status).toBe(401);
      expect(endImpersonationMock).not.toHaveBeenCalled();
    });

    it("ends the session identified in the request body", async () => {
      const res = await request(app)
        .post("/api/admin/impersonate/end")
        .set("Cookie", [adminCookie()])
        .send({ sessionId: "s-2" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ended: true });
      expect(endImpersonationMock).toHaveBeenCalledWith({ sessionId: "s-2", endedBy: ADMIN_ADDRESS });
      // Falls back to a DB lookup only when no sessionId is supplied.
      expect(findFirstMock).not.toHaveBeenCalled();
    });

    it("falls back to the admin's most recent active session when no sessionId is given", async () => {
      findFirstMock.mockResolvedValue({ id: "s-3" });

      const res = await request(app)
        .post("/api/admin/impersonate/end")
        .set("Cookie", [adminCookie()])
        .send({});

      expect(res.status).toBe(200);
      expect(findFirstMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ adminAddress: ADMIN_ADDRESS, endedAt: null }),
        })
      );
      expect(endImpersonationMock).toHaveBeenCalledWith({ sessionId: "s-3", endedBy: ADMIN_ADDRESS });
    });

    it("is a safe no-op when there is no active session to end", async () => {
      findFirstMock.mockResolvedValue(null);

      const res = await request(app)
        .post("/api/admin/impersonate/end")
        .set("Cookie", [adminCookie()])
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ended: true });
      expect(endImpersonationMock).not.toHaveBeenCalled();
    });

    it("always clears the impersonation cookie", async () => {
      findFirstMock.mockResolvedValue(null);

      const res = await request(app)
        .post("/api/admin/impersonate/end")
        .set("Cookie", [adminCookie()])
        .send({});

      const setCookie = res.headers["set-cookie"] as unknown as string[];
      expect(setCookie.some((c) => c.startsWith("impersonation_token=;"))).toBe(true);
    });
  });

  describe("GET /api/admin/impersonate/status", () => {
    it("reports inactive with no impersonation cookie, without touching the service", async () => {
      const res = await request(app).get("/api/admin/impersonate/status");
      expect(res.status).toBe(200);
      expect(res.body.active).toBe(false);
      expect(getImpersonationStatusMock).not.toHaveBeenCalled();
    });

    it("reports active status decoded from a valid impersonation cookie", async () => {
      const impersonationToken = jwt.sign(
        {
          walletAddress: TARGET_ADDRESS,
          network: "testnet",
          impersonation: { sessionId: "s-4", adminAddress: ADMIN_ADDRESS, readOnly: true },
        },
        JWT_SECRET,
        { expiresIn: "15m" }
      );
      getImpersonationStatusMock.mockResolvedValue({
        active: true,
        sessionId: "s-4",
        adminAddress: ADMIN_ADDRESS,
        targetAddress: TARGET_ADDRESS,
        startedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:15:00.000Z",
      });

      const res = await request(app)
        .get("/api/admin/impersonate/status")
        .set("Cookie", [`impersonation_token=${impersonationToken}`]);

      expect(res.status).toBe(200);
      expect(res.body.active).toBe(true);
      expect(getImpersonationStatusMock).toHaveBeenCalledWith("s-4");
    });

    it("reports inactive for a forged impersonation cookie without throwing", async () => {
      const res = await request(app)
        .get("/api/admin/impersonate/status")
        .set("Cookie", ["impersonation_token=garbage"]);

      expect(res.status).toBe(200);
      expect(res.body.active).toBe(false);
    });
  });
});
