import express from "express";
import request from "supertest";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { Keypair } from "@stellar/stellar-sdk";
import { ethers } from "ethers";
import nacl from "tweetnacl";
import bs58 from "bs58";

import { verificationRouter } from "../routes/verification.js";
import { authRouter } from "../routes/auth.js";
import { authMiddleware, AuthenticatedRequest } from "../middleware/auth.js";
import {
  createChallenge,
  consumeChallenge,
  _clearStore,
  _setEntry,
} from "../services/challengeStore.js";
import {
  verifyUploadAuthorization,
  _setWhitelist,
} from "../services/contractorAuth.js";
import { generateStepUpCode } from "../services/locationAnomalyService.js";

// Mock database services
jest.mock("../services/db.js", () => ({
  upsertApplicant: jest.fn().mockImplementation((walletAddress: string) =>
    Promise.resolve({ id: `applicant-${walletAddress.slice(0, 8)}` })
  ),
  createVerificationResult: jest.fn().mockResolvedValue({ id: "verification-1" }),
  prisma: {
    applicant: {
      findFirst: jest.fn().mockResolvedValue({ id: "applicant-test-id" }),
    },
    waitlistEntry: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  },
}));

// Bypass rate limiters in tests
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
  sensitiveRateLimiter: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => next(),
  mutationRateLimiter: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => next(),
}));

const JWT_SECRET = process.env.JWT_SECRET || "default_jwt_secret";

function signStellarChallenge(keypair: Keypair, challenge: string): string {
  return Buffer.from(keypair.sign(Buffer.from(challenge, "utf8"))).toString("hex");
}

function signSolanaChallenge(keypair: nacl.SignKeyPair, challenge: string): string {
  const messageBytes = new TextEncoder().encode(challenge);
  const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
  return Buffer.from(signature).toString("hex");
}

function extractCookieValue(
  headers: Record<string, any>,
  cookieName: string
): string | undefined {
  const setCookie = headers["set-cookie"];
  if (!setCookie) return undefined;
  const cookieHeaders = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const cookieStr of cookieHeaders) {
    const match = cookieStr.match(new RegExp(`^${cookieName}=([^;]+)`));
    if (match) return match[1];
  }
  return undefined;
}

function isCookieCleared(
  headers: Record<string, any>,
  cookieName: string
): boolean {
  const setCookie = headers["set-cookie"];
  if (!setCookie) return false;
  const cookieHeaders = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const cookieStr of cookieHeaders) {
    if (
      cookieStr.startsWith(`${cookieName}=;`) ||
      cookieStr.includes(`${cookieName}=;`) ||
      (cookieStr.startsWith(`${cookieName}=`) && cookieStr.includes("Expires=Thu, 01 Jan 1970"))
    ) {
      return true;
    }
  }
  return false;
}

describe("Security: Automated Session Fixation & Token Replay Prevention", () => {
  let app: express.Express;

  beforeEach(() => {
    _clearStore();
    _setWhitelist(null);
    jest.clearAllMocks();

    app = express();
    app.use(express.json());
    app.use(cookieParser());

    // Mount verification and auth routes
    app.use("/api/verification", verificationRouter);
    app.use("/api/auth", authRouter);

    // Protected route to test access with issued vs pre-auth session tokens
    app.get(
      "/api/protected",
      authMiddleware as express.RequestHandler,
      (req: AuthenticatedRequest, res) => {
        res.json({
          status: "authenticated",
          user: req.user,
        });
      }
    );
  });

  afterEach(() => {
    _setWhitelist(null);
  });

  describe("1. Session Fixation Attack Prevention", () => {
    it("issues a new session identifier on login and never reuses a pre-authentication session ID", async () => {
      const preAuthSessionId = "attacker-fixed-session-id-99999";
      const keypair = Keypair.random();
      const walletAddress = keypair.publicKey();

      // Step 1: Issue challenge
      const challengeRes = await request(app)
        .post("/api/verification/challenge")
        .send({ walletAddress, network: "stellar" });
      expect(challengeRes.status).toBe(200);
      const { challenge } = challengeRes.body;

      const signature = signStellarChallenge(keypair, challenge);

      // Step 2: Attacker injects pre-authentication session cookie into the login request
      const loginRes = await request(app)
        .post("/api/verification/verify-ownership")
        .set("Cookie", `token=${preAuthSessionId}`)
        .send({
          walletAddress,
          network: "stellar",
          challenge,
          signature,
        });

      expect(loginRes.status).toBe(200);
      expect(loginRes.body.verified).toBe(true);
      expect(loginRes.headers["set-cookie"]).toBeDefined();

      // Verify a new session token is issued in Set-Cookie
      const newSessionToken = extractCookieValue(loginRes.headers, "token");
      expect(newSessionToken).toBeDefined();
      expect(newSessionToken).not.toBe(preAuthSessionId);

      // Step 3: Provably assert the pre-authentication session ID is rejected on protected routes
      const preAuthAccessRes = await request(app)
        .get("/api/protected")
        .set("Cookie", `token=${preAuthSessionId}`);
      expect(preAuthAccessRes.status).toBe(401);
      expect(preAuthAccessRes.body.error).toBe("unauthorized");

      // Step 4: Provably assert the newly issued rotated session token succeeds on protected routes
      const validAccessRes = await request(app)
        .get("/api/protected")
        .set("Cookie", `token=${newSessionToken}`);
      expect(validAccessRes.status).toBe(200);
      expect(validAccessRes.body.status).toBe("authenticated");
      expect(validAccessRes.body.user.walletAddress).toBe(walletAddress);
    });

    it("invalidates and rotates away an existing valid JWT from another session on login", async () => {
      // Attacker generates a valid session JWT for their own wallet
      const attackerWallet = Keypair.random().publicKey();
      const attackerToken = jwt.sign(
        { walletAddress: attackerWallet, network: "stellar" },
        JWT_SECRET,
        { expiresIn: "1h" }
      );

      // Victim logs in with their own wallet
      const victimKeypair = Keypair.random();
      const victimWallet = victimKeypair.publicKey();

      const challengeRes = await request(app)
        .post("/api/verification/challenge")
        .send({ walletAddress: victimWallet, network: "stellar" });
      const { challenge } = challengeRes.body;
      const signature = signStellarChallenge(victimKeypair, challenge);

      // Request carries attacker's pre-set session cookie
      const loginRes = await request(app)
        .post("/api/verification/verify-ownership")
        .set("Cookie", `token=${attackerToken}`)
        .send({
          walletAddress: victimWallet,
          network: "stellar",
          challenge,
          signature,
        });

      expect(loginRes.status).toBe(200);
      const newSessionToken = extractCookieValue(loginRes.headers, "token");
      expect(newSessionToken).toBeDefined();
      expect(newSessionToken).not.toBe(attackerToken);

      // Accessing protected endpoint with attacker's token must NOT yield victim's session
      const attackerAccessRes = await request(app)
        .get("/api/protected")
        .set("Cookie", `token=${attackerToken}`);
      expect(attackerAccessRes.status).toBe(200);
      expect(attackerAccessRes.body.user.walletAddress).toBe(attackerWallet);
      expect(attackerAccessRes.body.user.walletAddress).not.toBe(victimWallet);

      // Accessing protected endpoint with the new token yields victim's session
      const victimAccessRes = await request(app)
        .get("/api/protected")
        .set("Cookie", `token=${newSessionToken}`);
      expect(victimAccessRes.status).toBe(200);
      expect(victimAccessRes.body.user.walletAddress).toBe(victimWallet);
    });

    it("clears and rotates alternative session cookie names (session cookie) upon login", async () => {
      const fixedSessionCookie = "attacker-pre-fixed-session-cookie";
      const keypair = Keypair.random();
      const walletAddress = keypair.publicKey();

      const challengeRes = await request(app)
        .post("/api/verification/challenge")
        .send({ walletAddress, network: "stellar" });
      const { challenge } = challengeRes.body;
      const signature = signStellarChallenge(keypair, challenge);

      const loginRes = await request(app)
        .post("/api/verification/verify-ownership")
        .set("Cookie", `session=${fixedSessionCookie}`)
        .send({
          walletAddress,
          network: "stellar",
          challenge,
          signature,
        });

      expect(loginRes.status).toBe(200);
      // New token cookie is set
      const newToken = extractCookieValue(loginRes.headers, "token");
      expect(newToken).toBeDefined();

      // Legacy/alternative session cookie is cleared
      expect(isCookieCleared(loginRes.headers, "session")).toBe(true);

      // Pre-set session cookie is rejected on protected routes
      const rejectRes = await request(app)
        .get("/api/protected")
        .set("Cookie", `session=${fixedSessionCookie}`);
      expect(rejectRes.status).toBe(401);
    });

    it("rotates session identifier on registration endpoint (/api/auth/register)", async () => {
      const preAuthId = "pre-auth-registration-token-abc";
      const keypair = Keypair.random();
      const walletAddress = keypair.publicKey();

      const regRes = await request(app)
        .post("/api/auth/register")
        .set("Cookie", `token=${preAuthId}`)
        .send({
          walletAddress,
          email: "test@example.com",
        });

      expect(regRes.status).toBe(201);
      const newToken = extractCookieValue(regRes.headers, "token");
      expect(newToken).toBeDefined();
      expect(newToken).not.toBe(preAuthId);

      // Pre-auth session ID cannot access protected endpoints
      const protectedRes = await request(app)
        .get("/api/protected")
        .set("Cookie", `token=${preAuthId}`);
      expect(protectedRes.status).toBe(401);

      // Rotated token can access protected endpoints
      const accessRes = await request(app)
        .get("/api/protected")
        .set("Cookie", `token=${newToken}`);
      expect(accessRes.status).toBe(200);
      expect(accessRes.body.user.walletAddress).toBe(walletAddress);
    });

    it("rotates session identifier on step-up verification (/api/verification/step-up)", async () => {
      const preStepUpId = "pre-step-up-session-id-xyz";
      const keypair = Keypair.random();
      const walletAddress = keypair.publicKey();

      const stepUpCode = generateStepUpCode(walletAddress);

      const stepUpRes = await request(app)
        .post("/api/verification/step-up")
        .set("Cookie", `token=${preStepUpId}`)
        .send({
          walletAddress,
          network: "stellar",
          code: stepUpCode,
        });

      expect(stepUpRes.status).toBe(200);
      expect(stepUpRes.body.stepUpCompleted).toBe(true);

      const newToken = extractCookieValue(stepUpRes.headers, "token");
      expect(newToken).toBeDefined();
      expect(newToken).not.toBe(preStepUpId);

      // Old pre-step-up session token is rejected
      const protectedRes = await request(app)
        .get("/api/protected")
        .set("Cookie", `token=${preStepUpId}`);
      expect(protectedRes.status).toBe(401);
    });
  });

  describe("2. Token and Signature Replay Attack Prevention", () => {
    it("rejects replaying a previously valid Stellar wallet-challenge signature on the second attempt", async () => {
      const keypair = Keypair.random();
      const walletAddress = keypair.publicKey();

      // Issue challenge
      const challengeRes = await request(app)
        .post("/api/verification/challenge")
        .send({ walletAddress, network: "stellar" });
      const { challenge } = challengeRes.body;
      const signature = signStellarChallenge(keypair, challenge);

      const payload = {
        walletAddress,
        network: "stellar",
        challenge,
        signature,
      };

      // First verification attempt: Valid, succeeds
      const firstRes = await request(app)
        .post("/api/verification/verify-ownership")
        .send(payload);

      expect(firstRes.status).toBe(200);
      expect(firstRes.body.verified).toBe(true);
      expect(firstRes.headers["set-cookie"]).toBeDefined();

      // Second attempt: Replaying the captured signature within its original 5-minute validity window
      const replayRes = await request(app)
        .post("/api/verification/verify-ownership")
        .send(payload);

      expect(replayRes.status).toBe(410);
      expect(replayRes.body).toEqual({
        error: "challenge_invalid",
        reason: "already_used",
      });
      // Ensure no session cookie is issued on replay
      expect(replayRes.headers["set-cookie"]).toBeUndefined();

      // Third attempt: Subsequent replay attempts are also rejected outright
      const thirdRes = await request(app)
        .post("/api/verification/verify-ownership")
        .send(payload);

      expect(thirdRes.status).toBe(410);
      expect(thirdRes.body.reason).toBe("already_used");
      expect(thirdRes.headers["set-cookie"]).toBeUndefined();
    });

    it("rejects replaying a previously valid Ethereum (EIP-191) signature on replay within validity window", async () => {
      const wallet = ethers.Wallet.createRandom();
      const walletAddress = wallet.address;

      const challengeRes = await request(app)
        .post("/api/verification/challenge")
        .send({ walletAddress, network: "ethereum" });
      const { challenge } = challengeRes.body;
      const signature = await wallet.signMessage(challenge);

      const payload = {
        walletAddress,
        network: "ethereum",
        challenge,
        signature,
      };

      // Attempt 1: Authenticates successfully
      const firstRes = await request(app)
        .post("/api/verification/verify-ownership")
        .send(payload);
      expect(firstRes.status).toBe(200);
      expect(firstRes.body.verified).toBe(true);

      // Attempt 2 (Replay): Rejected
      const replayRes = await request(app)
        .post("/api/verification/verify-ownership")
        .send(payload);
      expect(replayRes.status).toBe(410);
      expect(replayRes.body.error).toBe("challenge_invalid");
      expect(replayRes.body.reason).toBe("already_used");
      expect(replayRes.headers["set-cookie"]).toBeUndefined();
    });

    it("rejects replaying a previously valid Solana (Ed25519) signature on replay within validity window", async () => {
      const keypair = nacl.sign.keyPair();
      const walletAddress = bs58.encode(keypair.publicKey);

      const challengeRes = await request(app)
        .post("/api/verification/challenge")
        .send({ walletAddress, network: "solana" });
      const { challenge } = challengeRes.body;
      const signature = signSolanaChallenge(keypair, challenge);

      const payload = {
        walletAddress,
        network: "solana",
        challenge,
        signature,
      };

      // Attempt 1: Authenticates successfully
      const firstRes = await request(app)
        .post("/api/verification/verify-ownership")
        .send(payload);
      expect(firstRes.status).toBe(200);
      expect(firstRes.body.verified).toBe(true);

      // Attempt 2 (Replay): Rejected
      const replayRes = await request(app)
        .post("/api/verification/verify-ownership")
        .send(payload);
      expect(replayRes.status).toBe(410);
      expect(replayRes.body.error).toBe("challenge_invalid");
      expect(replayRes.body.reason).toBe("already_used");
      expect(replayRes.headers["set-cookie"]).toBeUndefined();
    });

    it("rejects replaying contractor upload challenge signatures in contractorAuth", async () => {
      const keypair = Keypair.random();
      const address = keypair.publicKey();
      _setWhitelist([address]);

      const challenge = createChallenge(address);
      const signature = signStellarChallenge(keypair, challenge);

      // First authentication: valid
      const firstResult = verifyUploadAuthorization({
        address,
        challenge,
        signature,
      });
      expect(firstResult.ok).toBe(true);

      // Second authentication (Replay attack): rejected
      const replayResult = verifyUploadAuthorization({
        address,
        challenge,
        signature,
      });
      expect(replayResult.ok).toBe(false);
      if (!replayResult.ok) {
        expect(replayResult.error).toBe("challenge_invalid");
        expect(replayResult.message).toContain("already_used");
      }
    });
  });

  describe("3. Nonce Expiration and Consumption Lifecycle", () => {
    it("rejects expired nonces outright even when cryptographic signature is valid", async () => {
      const keypair = Keypair.random();
      const walletAddress = keypair.publicKey();

      const challenge = "RemitMortgage-verify-expired-nonce-001";
      // Challenge expired 1 second ago
      _setEntry(walletAddress, {
        challenge,
        expiresAt: Date.now() - 1000,
        used: false,
      });

      const signature = signStellarChallenge(keypair, challenge);

      const res = await request(app)
        .post("/api/verification/verify-ownership")
        .send({
          walletAddress,
          network: "stellar",
          challenge,
          signature,
        });

      expect(res.status).toBe(410);
      expect(res.body).toEqual({
        error: "challenge_invalid",
        reason: "expired",
      });
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("rejects already-consumed nonces outright without verifying signature", async () => {
      const keypair = Keypair.random();
      const walletAddress = keypair.publicKey();

      const challenge = "RemitMortgage-verify-consumed-nonce-002";
      _setEntry(walletAddress, {
        challenge,
        expiresAt: Date.now() + 60000,
        used: true, // Already consumed
      });

      const signature = signStellarChallenge(keypair, challenge);

      const res = await request(app)
        .post("/api/verification/verify-ownership")
        .send({
          walletAddress,
          network: "stellar",
          challenge,
          signature,
        });

      expect(res.status).toBe(410);
      expect(res.body).toEqual({
        error: "challenge_invalid",
        reason: "already_used",
      });
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("rejects unissued, forged, or tampered nonces outright", async () => {
      const keypair = Keypair.random();
      const walletAddress = keypair.publicKey();

      // Nonce that was never created
      const forgedChallenge = "RemitMortgage-verify-forged-nonce-9999-1700000000000";
      const signature = signStellarChallenge(keypair, forgedChallenge);

      const res = await request(app)
        .post("/api/verification/verify-ownership")
        .send({
          walletAddress,
          network: "stellar",
          challenge: forgedChallenge,
          signature,
        });

      expect(res.status).toBe(410);
      expect(res.body).toEqual({
        error: "challenge_invalid",
        reason: "not_found",
      });
      expect(res.headers["set-cookie"]).toBeUndefined();

      // Tampered challenge (real challenge altered by 1 char)
      const realChallenge = createChallenge(walletAddress);
      const tamperedChallenge = realChallenge + "-tampered";
      const tamperedSig = signStellarChallenge(keypair, tamperedChallenge);

      const tamperedRes = await request(app)
        .post("/api/verification/verify-ownership")
        .send({
          walletAddress,
          network: "stellar",
          challenge: tamperedChallenge,
          signature: tamperedSig,
        });

      expect(tamperedRes.status).toBe(410);
      expect(tamperedRes.body).toEqual({
        error: "challenge_invalid",
        reason: "not_found",
      });
      expect(tamperedRes.headers["set-cookie"]).toBeUndefined();
    });

    it("rejects cross-wallet challenge reuse (nonce issued to wallet A presented by wallet B)", async () => {
      const keypairA = Keypair.random();
      const walletA = keypairA.publicKey();
      const keypairB = Keypair.random();
      const walletB = keypairB.publicKey();

      // Issue challenge to Wallet A
      const challenge = createChallenge(walletA);
      // Wallet B attempts to sign Wallet A's challenge and present it for Wallet B
      const signatureB = signStellarChallenge(keypairB, challenge);

      const res = await request(app)
        .post("/api/verification/verify-ownership")
        .send({
          walletAddress: walletB,
          network: "stellar",
          challenge,
          signature: signatureB,
        });

      expect(res.status).toBe(410);
      expect(res.body.reason).toBe("not_found");
      expect(res.headers["set-cookie"]).toBeUndefined();
    });
  });

  describe("4. Concurrency & Race-Condition Replay Prevention", () => {
    it("handles concurrent replay attempts so that exactly one succeeds and all others are rejected", async () => {
      const keypair = Keypair.random();
      const walletAddress = keypair.publicKey();

      const challenge = createChallenge(walletAddress);
      const signature = signStellarChallenge(keypair, challenge);

      const payload = {
        walletAddress,
        network: "stellar",
        challenge,
        signature,
      };

      // Launch 5 simultaneous requests with the identical challenge and signature
      const responses = await Promise.all([
        request(app).post("/api/verification/verify-ownership").send(payload),
        request(app).post("/api/verification/verify-ownership").send(payload),
        request(app).post("/api/verification/verify-ownership").send(payload),
        request(app).post("/api/verification/verify-ownership").send(payload),
        request(app).post("/api/verification/verify-ownership").send(payload),
      ]);

      const successResponses = responses.filter((r) => r.status === 200);
      const rejectedResponses = responses.filter((r) => r.status === 410);

      // Exactly 1 request must have succeeded
      expect(successResponses.length).toBe(1);
      expect(successResponses[0].body.verified).toBe(true);
      expect(successResponses[0].headers["set-cookie"]).toBeDefined();

      // All remaining 4 requests must have been rejected as already_used
      expect(rejectedResponses.length).toBe(4);
      for (const rej of rejectedResponses) {
        expect(rej.body).toEqual({
          error: "challenge_invalid",
          reason: "already_used",
        });
        expect(rej.headers["set-cookie"]).toBeUndefined();
      }
    });
  });
});
