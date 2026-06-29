import express from "express";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { milestoneRouter } from "../routes/milestone";
import { createChallenge, _clearStore } from "../services/challengeStore";
import { _setWhitelist } from "../services/contractorAuth";

// Avoid hitting Pinata during the test — stub the pinning call.
jest.mock("../services/ipfs.js", () => ({
  pinFileToIPFS: jest.fn().mockResolvedValue("QmTestCid000000000000000000000000000000000000"),
  unpinFileFromIPFS: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock("../services/ipfsAudit.js", () => ({ logUnpinnedCid: jest.fn() }));
jest.mock("../services/ipfsCleanup.js", () => ({ unpinEvidenceCid: jest.fn() }));

function sign(keypair: Keypair, challenge: string): string {
  return Buffer.from(keypair.sign(Buffer.from(challenge, "utf8"))).toString("hex");
}

describe("POST /api/milestone/upload authorization", () => {
  let app: express.Express;
  const contractor = Keypair.random();
  const outsider = Keypair.random();
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  beforeEach(() => {
    _clearStore();
    _setWhitelist([contractor.publicKey()]);
    app = express();
    app.use("/api/milestone", milestoneRouter);
  });

  afterAll(() => _setWhitelist(null));

  it("rejects uploads with no signature (400)", async () => {
    const res = await request(app)
      .post("/api/milestone/upload")
      .attach("file", PNG, { filename: "p.png", contentType: "image/png" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_auth");
  });

  it("rejects a non-whitelisted address (401)", async () => {
    const challenge = createChallenge(outsider.publicKey());
    const res = await request(app)
      .post("/api/milestone/upload")
      .set("x-wallet-address", outsider.publicKey())
      .set("x-challenge", challenge)
      .set("x-signature", sign(outsider, challenge))
      .attach("file", PNG, { filename: "p.png", contentType: "image/png" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("rejects a bad signature from a whitelisted address (401)", async () => {
    const challenge = createChallenge(contractor.publicKey());
    const res = await request(app)
      .post("/api/milestone/upload")
      .set("x-wallet-address", contractor.publicKey())
      .set("x-challenge", challenge)
      .set("x-signature", sign(outsider, challenge)) // wrong signer
      .attach("file", PNG, { filename: "p.png", contentType: "image/png" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_signature");
  });

  it("accepts a valid whitelisted-contractor signature (201)", async () => {
    const challenge = createChallenge(contractor.publicKey());
    const res = await request(app)
      .post("/api/milestone/upload")
      .set("x-wallet-address", contractor.publicKey())
      .set("x-challenge", challenge)
      .set("x-signature", sign(contractor, challenge))
      .attach("file", PNG, { filename: "p.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    expect(res.body.cid).toBeDefined();
  });

  it("rejects a replayed challenge (401)", async () => {
    const challenge = createChallenge(contractor.publicKey());
    const headers = {
      "x-wallet-address": contractor.publicKey(),
      "x-challenge": challenge,
      "x-signature": sign(contractor, challenge),
    };
    const first = await request(app)
      .post("/api/milestone/upload")
      .set(headers)
      .attach("file", PNG, { filename: "p.png", contentType: "image/png" });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/milestone/upload")
      .set(headers)
      .attach("file", PNG, { filename: "p.png", contentType: "image/png" });
    expect(second.status).toBe(401);
    expect(second.body.error).toBe("challenge_invalid");
  });
});
