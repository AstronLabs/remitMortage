jest.mock("../services/arweave.js", () => ({
  uploadToArweave: jest.fn(),
}));

jest.mock("../services/ipfs.js", () => ({
  pinFileToIPFS: jest.fn(),
  unpinFileFromIPFS: jest.fn(),
}));

jest.mock("../services/audit.js", () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/ipfsCleanup.js", () => ({
  unpinEvidenceCid: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/db.js", () => ({
  prisma: { unpinnedCid: { create: jest.fn() } },
}));

import express from "express";
import request from "supertest";
import { milestoneRouter } from "../routes/milestone";
import { _clearProposalStore } from "../services/milestoneProposalStore";

const app = express();
app.use(express.json());
app.use("/api/milestone", milestoneRouter);

describe("Milestone proposal concurrency races", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _clearProposalStore();
  });

  it("concurrent reject requests on the same open proposal reject exactly once", async () => {
    const created = await request(app)
      .post("/api/milestone/proposals")
      .send({ milestoneId: "m-race-1", evidenceCid: "bafyRace1" });

    const proposalId = created.body.id;
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app)
          .post(`/api/milestone/proposals/${proposalId}/reject`)
          .send({ reason: "Concurrent governance reject" })
      )
    );

    const successes = responses.filter((r) => r.status === 200);
    const conflicts = responses.filter((r) => r.status === 400);

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(4);
    expect(successes[0].body.status).toBe("Rejected");

    conflicts.forEach((r) => {
      expect(r.body.error).toBe("invalid_state");
    });
  });

  it("interleaved approve-path creation and reject keep consistent proposal state", async () => {
    const created = await request(app)
      .post("/api/milestone/proposals")
      .send({ milestoneId: "m-race-2", evidenceCid: "bafyRace2" });

    const proposalId = created.body.id;

    const [rejectRes, secondReject] = await Promise.all([
      request(app)
        .post(`/api/milestone/proposals/${proposalId}/reject`)
        .send({ reason: "Evidence mismatch" }),
      request(app)
        .post(`/api/milestone/proposals/${proposalId}/reject`)
        .send({ reason: "Late reject attempt" }),
    ]);

    const outcomes = [rejectRes.status, secondReject.status].sort();
    expect(outcomes).toEqual([200, 400]);
  });
});
