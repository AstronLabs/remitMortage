import express from "express";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { verificationRouter } from "../routes/verification";
import { _clearStore } from "../services/challengeStore";

jest.mock("../services/stellar.js", () => ({
  analyzeRemittanceHistory: jest.fn(),
}));

jest.mock("../services/db.js", () => ({
  upsertApplicant: jest.fn().mockResolvedValue({ id: "app-1" }),
  createVerificationResult: jest.fn().mockResolvedValue({ id: "vr-1" }),
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

const app = express();
app.use(express.json());
app.use("/api/verification", verificationRouter);

function signChallenge(keypair: Keypair, challenge: string): string {
  return Buffer.from(keypair.sign(Buffer.from(challenge, "utf8"))).toString("hex");
}

beforeEach(() => {
  _clearStore();
  jest.clearAllMocks();
});

describe("Wallet challenge verification — full integration flow", () => {
  it("issues a challenge, verifies a valid signature, and rejects reused challenges", async () => {
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();

    // Step 1: Request a challenge
    const challengeRes = await request(app)
      .post("/api/verification/challenge")
      .send({ walletAddress, network: "stellar" });

    expect(challengeRes.status).toBe(200);
    const { challenge } = challengeRes.body;
    expect(challenge).toMatch(/^RemitMortgage-verify-/);

    // Step 2: Sign and verify ownership
    const verifyRes = await request(app)
      .post("/api/verification/verify-ownership")
      .send({
        walletAddress,
        network: "stellar",
        challenge,
        signature: signChallenge(keypair, challenge),
      });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body).toEqual({
      verified: true,
      walletAddress,
      network: "stellar",
    });

    // Step 3: Reusing the same challenge should fail with 410
    const reuseRes = await request(app)
      .post("/api/verification/verify-ownership")
      .send({
        walletAddress,
        network: "stellar",
        challenge,
        signature: signChallenge(keypair, challenge),
      });

    expect(reuseRes.status).toBe(410);
    expect(reuseRes.body.reason).toBe("already_used");
  });

  it("rejects a tampered challenge payload with 401", async () => {
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();

    const challengeRes = await request(app)
      .post("/api/verification/challenge")
      .send({ walletAddress, network: "stellar" });

    const { challenge } = challengeRes.body;

    const tamperedChallenge = challenge + "-tampered";
    const signature = signChallenge(keypair, tamperedChallenge);

    const verifyRes = await request(app)
      .post("/api/verification/verify-ownership")
      .send({
        walletAddress,
        network: "stellar",
        challenge: tamperedChallenge,
        signature,
      });

    expect(verifyRes.status).toBe(410);
    expect(verifyRes.body.reason).toBe("not_found");
  });

  it("returns 401 for an invalid signature", async () => {
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();

    const challengeRes = await request(app)
      .post("/api/verification/challenge")
      .send({ walletAddress, network: "stellar" });

    const { challenge } = challengeRes.body;

    const wrongKeypair = Keypair.random();
    const signature = signChallenge(wrongKeypair, challenge);

    const verifyRes = await request(app)
      .post("/api/verification/verify-ownership")
      .send({
        walletAddress,
        network: "stellar",
        challenge,
        signature,
      });

    expect(verifyRes.status).toBe(401);
    expect(verifyRes.body.error).toBe("invalid_signature");
  });

  it("returns 400 when challenge or signature fields are missing", async () => {
    const walletAddress = Keypair.random().publicKey();

    const res = await request(app)
      .post("/api/verification/verify-ownership")
      .send({ walletAddress, network: "stellar" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_field");
  });

  it("returns 400 for missing walletAddress on challenge endpoint", async () => {
    const res = await request(app)
      .post("/api/verification/challenge")
      .send({ network: "stellar" });

    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid wallet address format", async () => {
    const res = await request(app)
      .post("/api/verification/challenge")
      .send({ walletAddress: "not-a-valid-address", network: "stellar" });

    expect(res.status).toBe(400);
  });
});
