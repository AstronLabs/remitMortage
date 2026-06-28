import express from "express";
import request from "supertest";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { Keypair } from "@stellar/stellar-sdk";
import { authMiddleware, AuthenticatedRequest } from "../middleware/auth";
import { verificationRouter } from "../routes/verification";
import {
  consumeChallenge,
  createChallenge,
  _clearStore,
  _setEntry
} from "../services/challengeStore";

jest.mock("../services/db.js", () => ({
  upsertApplicant: jest.fn().mockResolvedValue({ id: "applicant-1" }),
  createVerificationResult: jest.fn().mockResolvedValue({ id: "verification-1" }),
}));

jest.mock("../middleware/rateLimit.js", () => ({
  verificationChallengeRateLimiter: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => next(),
  verificationOwnershipRateLimiter: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => next(),
}));

function signStellarChallenge(keypair: Keypair, challenge: string): string {
  return Buffer.from(keypair.sign(Buffer.from(challenge, "utf8"))).toString("hex");
}

describe("authMiddleware", () => {
  let app: express.Express;
  const JWT_SECRET = process.env.JWT_SECRET || "default_jwt_secret";

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(cookieParser());

    app.get(
      "/api/protected",
      authMiddleware as express.RequestHandler,
      (req: AuthenticatedRequest, res) => {
        res.json({ message: "success", user: req.user });
      }
    );
  });

  it("should return 401 if token cookie is missing", async () => {
    const res = await request(app).get("/api/protected");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
    expect(res.body.message).toBe("Authentication token missing");
  });

  it("should return 401 if token is invalid or expired", async () => {
    const res = await request(app)
      .get("/api/protected")
      .set("Cookie", ["token=invalid-token"]);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
    expect(res.body.message).toBe("Invalid or expired token");
  });

  it("should succeed and populate req.user if valid token is provided", async () => {
    const payload = { walletAddress: "GAAA...", network: "stellar" };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "24h" });

    const res = await request(app)
      .get("/api/protected")
      .set("Cookie", [`token=${token}`]);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("success");
    expect(res.body.user).toEqual(expect.objectContaining(payload));
  });
});

describe("Verification Route Secure Cookie Flags", () => {
  let app: express.Express;

  beforeEach(() => {
    _clearStore();
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api/verification", verificationRouter);
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  it("should not set Secure flag in development/test by default", async () => {
    process.env.NODE_ENV = "test";
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();

    const challenge = "RemitMortgage-verify-dev-0";
    _setEntry(walletAddress, {
      challenge,
      expiresAt: Date.now() + 10000,
      used: false,
    });

    const res = await request(app)
      .post("/api/verification/verify-ownership")
      .send({
        walletAddress,
        network: "stellar",
        challenge,
        signature: signStellarChallenge(keypair, challenge),
      });

    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeDefined();
    const cookie = res.headers["set-cookie"][0];
    expect(cookie).toContain("token=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Secure");
  });

  it("should set Secure flag in production environment", async () => {
    process.env.NODE_ENV = "production";
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();

    const challenge = "RemitMortgage-verify-prod-0";
    _setEntry(walletAddress, {
      challenge,
      expiresAt: Date.now() + 10000,
      used: false,
    });

    const res = await request(app)
      .post("/api/verification/verify-ownership")
      .send({
        walletAddress,
        network: "stellar",
        challenge,
        signature: signStellarChallenge(keypair, challenge),
      });

    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeDefined();
    const cookie = res.headers["set-cookie"][0];
    expect(cookie).toContain("token=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
  });
});
