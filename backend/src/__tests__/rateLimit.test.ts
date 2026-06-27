import express from "express";
import request from "supertest";
import { verificationRouter } from "../routes/verification";

jest.mock("../services/db.js", () => ({
  upsertApplicant: jest.fn(),
  createVerificationResult: jest.fn(),
}));

const app = express();
app.use(express.json());
app.use("/api/verification", verificationRouter);

describe("verificationChallengeRateLimiter", () => {
  const challengeBody = {
    walletAddress: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    network: "stellar",
  };

  it("blocks requests after 10 within a 60-second window", async () => {
    // Send 10 requests — all should be allowed.
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post("/api/verification/challenge")
        .send(challengeBody);
      expect(res.status).not.toBe(429);
    }

    // The 11th request must be rate-limited.
    const res = await request(app)
      .post("/api/verification/challenge")
      .send(challengeBody);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      error: "Too many requests",
      statusCode: 429,
    });
    expect(typeof res.body.retryAfter).toBe("number");
  });

  it("rate-limits /verify-ownership independently", async () => {
    const ownershipBody = {
      walletAddress: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      network: "stellar",
      challenge: "test-challenge",
      signature: "deadbeef",
    };

    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post("/api/verification/verify-ownership")
        .send(ownershipBody);
      expect(res.status).not.toBe(429);
    }

    const res = await request(app)
      .post("/api/verification/verify-ownership")
      .send(ownershipBody);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("Too many requests");
  });
});
