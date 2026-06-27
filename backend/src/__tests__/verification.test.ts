import express from "express";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { ethers } from "ethers";
import nacl from "tweetnacl";
import bs58 from "bs58";

import * as stellarService from "../services/stellar";
import { verificationRouter } from "../routes/verification";
import {
  _clearStore,
  _setEntry,
  consumeChallenge,
  createChallenge,
} from "../services/challengeStore";
import { verifyEvmSignature } from "../services/evm";
import { verifySolanaSignature } from "../services/solana";

jest.mock("../services/stellar");
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

const app = express();
app.use(express.json());
app.use("/api/verification", verificationRouter);

const mockedAnalyzeRemittanceHistory = jest.mocked(
  stellarService.analyzeRemittanceHistory
);

function signStellarChallenge(keypair: Keypair, challenge: string): string {
  return Buffer.from(keypair.sign(Buffer.from(challenge, "utf8"))).toString("hex");
}

function signSolanaChallenge(
  keypair: nacl.SignKeyPair,
  challenge: string
): string {
  const messageBytes = new TextEncoder().encode(challenge);
  const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
  return Buffer.from(signature).toString("hex");
}

beforeEach(() => {
  _clearStore();
  jest.clearAllMocks();
});

describe("challengeStore", () => {
  it("creates unique challenges", () => {
    const walletAddress = Keypair.random().publicKey();
    const first = createChallenge(walletAddress);
    const second = createChallenge(walletAddress);

    expect(first).toMatch(/^RemitMortgage-verify-[a-f0-9]+-\d+$/);
    expect(second).not.toBe(first);
  });

  it("marks a valid challenge as used", () => {
    const walletAddress = Keypair.random().publicKey();
    const challenge = createChallenge(walletAddress);

    expect(consumeChallenge(walletAddress, challenge)).toEqual({
      ok: true,
      challenge,
    });
  });

  it("returns already_used when the same challenge is consumed twice", () => {
    const walletAddress = Keypair.random().publicKey();
    const challenge = createChallenge(walletAddress);

    consumeChallenge(walletAddress, challenge);

    expect(consumeChallenge(walletAddress, challenge)).toEqual({
      ok: false,
      reason: "already_used",
    });
  });
});

describe("multi-chain signature helpers", () => {
  it("verifies a valid EIP-191 signature", async () => {
    const wallet = ethers.Wallet.createRandom();
    const challenge = "RemitMortgage-verify-evm-1000";
    const signature = await wallet.signMessage(challenge);

    expect(verifyEvmSignature(wallet.address, challenge, signature)).toBe(true);
  });

  it("rejects an EIP-191 signature from another wallet", async () => {
    const signer = ethers.Wallet.createRandom();
    const otherWallet = ethers.Wallet.createRandom();
    const challenge = "RemitMortgage-verify-evm-2000";
    const signature = await signer.signMessage(challenge);

    expect(verifyEvmSignature(otherWallet.address, challenge, signature)).toBe(false);
  });

  it("verifies a valid Solana signature", () => {
    const keypair = nacl.sign.keyPair();
    const walletAddress = bs58.encode(keypair.publicKey);
    const challenge = "RemitMortgage-verify-sol-1000";
    const signature = signSolanaChallenge(keypair, challenge);

    expect(verifySolanaSignature(walletAddress, challenge, signature)).toBe(true);
  });

  it("rejects a malformed Solana signature", () => {
    const keypair = nacl.sign.keyPair();
    const walletAddress = bs58.encode(keypair.publicKey);

    expect(verifySolanaSignature(walletAddress, "challenge", "not-a-signature")).toBe(
      false
    );
  });
});

describe("POST /api/verification/score", () => {
  it("returns a calculated credit score for valid request data", async () => {
    const senderAddress = Keypair.random().publicKey();
    const recipientAddress = Keypair.random().publicKey();

    mockedAnalyzeRemittanceHistory.mockResolvedValue({
      senderAddress,
      recipientAddress,
      totalPayments: 12,
      totalAmountUSDC: "6000",
      averageAmountUSDC: "500",
      standardDeviation: 0,
      spanMonths: 12,
      firstPayment: "2023-01-01",
      lastPayment: "2024-01-01",
      eligible: true,
      reason: "OK",
    });

    const res = await request(app)
      .post("/api/verification/score")
      .send({ senderAddress, recipientAddress });

    expect(res.status).toBe(200);
    expect(mockedAnalyzeRemittanceHistory).toHaveBeenCalledWith(
      senderAddress,
      recipientAddress
    );
    expect(res.body).toEqual({
      score: 100,
      breakdown: {
        consistency: 40,
        frequency: 25,
        duration: 20,
        volume: 15,
      },
      tier: "Excellent",
    });
  });
});

describe("POST /api/verification/challenge", () => {
  it("returns 400 for missing walletAddress", async () => {
    const res = await request(app)
      .post("/api/verification/challenge")
      .send({ network: "stellar" });

    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid Stellar address", async () => {
    const res = await request(app)
      .post("/api/verification/challenge")
      .send({ walletAddress: "NOT_A_VALID_ADDRESS", network: "stellar" });

    expect(res.status).toBe(400);
  });

  it("returns a challenge for a valid Stellar address", async () => {
    const walletAddress = Keypair.random().publicKey();

    const res = await request(app)
      .post("/api/verification/challenge")
      .send({ walletAddress, network: "stellar" });

    expect(res.status).toBe(200);
    expect(res.body.challenge).toMatch(/^RemitMortgage-verify-/);
  });

  it("returns a challenge for a valid Solana address", async () => {
    const keypair = nacl.sign.keyPair();
    const walletAddress = bs58.encode(keypair.publicKey);

    const res = await request(app)
      .post("/api/verification/challenge")
      .send({ walletAddress, network: "solana" });

    expect(res.status).toBe(200);
    expect(res.body.challenge).toMatch(/^RemitMortgage-verify-/);
  });

  it("returns 400 for an invalid Ethereum address", async () => {
    const res = await request(app)
      .post("/api/verification/challenge")
      .send({ walletAddress: "0xinvalid", network: "ethereum" });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/verification/verify-ownership — Stellar", () => {
  it("returns verified:true for a valid Stellar signature", async () => {
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();

    const challengeRes = await request(app)
      .post("/api/verification/challenge")
      .send({ walletAddress, network: "stellar" });
    const { challenge } = challengeRes.body;

    const res = await request(app)
      .post("/api/verification/verify-ownership")
      .send({
        walletAddress,
        network: "stellar",
        challenge,
        signature: signStellarChallenge(keypair, challenge),
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verified: true, walletAddress, network: "stellar" });
  });

  it("returns 401 for an invalid Stellar signature", async () => {
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();

    const challengeRes = await request(app)
      .post("/api/verification/challenge")
      .send({ walletAddress, network: "stellar" });
    const { challenge } = challengeRes.body;

    const res = await request(app)
      .post("/api/verification/verify-ownership")
      .send({
        walletAddress,
        network: "stellar",
        challenge,
        signature: Buffer.alloc(64).toString("hex"),
      });

    expect(res.status).toBe(401);
  });

  it("returns 410 for an expired Stellar challenge", async () => {
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();
    const challenge = "RemitMortgage-verify-expired-0";

    _setEntry(walletAddress, {
      challenge,
      expiresAt: Date.now() - 1,
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

    expect(res.status).toBe(410);
    expect(res.body.reason).toBe("expired");
  });

  it("returns 410 when the same Stellar challenge is reused", async () => {
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();

    const challengeRes = await request(app)
      .post("/api/verification/challenge")
      .send({ walletAddress, network: "stellar" });
    const { challenge } = challengeRes.body;
    const signature = signStellarChallenge(keypair, challenge);

    await request(app)
      .post("/api/verification/verify-ownership")
      .send({ walletAddress, network: "stellar", challenge, signature });

    const res = await request(app)
      .post("/api/verification/verify-ownership")
      .send({ walletAddress, network: "stellar", challenge, signature });

    expect(res.status).toBe(410);
    expect(res.body.reason).toBe("already_used");
  });

  it("returns 400 when challenge or signature are missing", async () => {
    const walletAddress = Keypair.random().publicKey();

    const res = await request(app)
      .post("/api/verification/verify-ownership")
      .send({ walletAddress, network: "stellar" });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/verification/verify-ownership — Ethereum", () => {
  it("returns verified:true for a valid Ethereum signature", async () => {
    const wallet = ethers.Wallet.createRandom();
    const walletAddress = wallet.address;

    const challengeRes = await request(app)
      .post("/api/verification/challenge")
      .send({ walletAddress, network: "ethereum" });
    const { challenge } = challengeRes.body;

    const signature = await wallet.signMessage(challenge);
    const res = await request(app)
      .post("/api/verification/verify-ownership")
      .send({ walletAddress, network: "ethereum", challenge, signature });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verified: true, walletAddress, network: "ethereum" });
  });

  it("returns 401 for a signature from a different Ethereum wallet", async () => {
    const wallet = ethers.Wallet.createRandom();
    const otherWallet = ethers.Wallet.createRandom();

    const challengeRes = await request(app)
      .post("/api/verification/challenge")
      .send({ walletAddress: wallet.address, network: "ethereum" });
    const { challenge } = challengeRes.body;

    const signature = await otherWallet.signMessage(challenge);
    const res = await request(app)
      .post("/api/verification/verify-ownership")
      .send({
        walletAddress: wallet.address,
        network: "ethereum",
        challenge,
        signature,
      });

    expect(res.status).toBe(401);
  });
});

describe("POST /api/verification/verify-ownership — Solana", () => {
  it("returns verified:true for a valid Solana signature", async () => {
    const keypair = nacl.sign.keyPair();
    const walletAddress = bs58.encode(keypair.publicKey);

    const challengeRes = await request(app)
      .post("/api/verification/challenge")
      .send({ walletAddress, network: "solana" });
    const { challenge } = challengeRes.body;

    const res = await request(app)
      .post("/api/verification/verify-ownership")
      .send({
        walletAddress,
        network: "solana",
        challenge,
        signature: signSolanaChallenge(keypair, challenge),
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verified: true, walletAddress, network: "solana" });
  });

  it("returns 401 for an invalid Solana signature", async () => {
    const keypair = nacl.sign.keyPair();
    const walletAddress = bs58.encode(keypair.publicKey);

    const challengeRes = await request(app)
      .post("/api/verification/challenge")
      .send({ walletAddress, network: "solana" });
    const { challenge } = challengeRes.body;

    const res = await request(app)
      .post("/api/verification/verify-ownership")
      .send({
        walletAddress,
        network: "solana",
        challenge,
        signature: Buffer.alloc(64).toString("hex"),
      });

    expect(res.status).toBe(401);
  });
});
