// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";
import { milestoneRouter } from "../routes/milestone";
import { logAudit } from "../services/audit";
import { _clearProposalStore } from "../services/milestoneProposalStore";

jest.mock("../services/audit.js", () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/ipfsCleanup.js", () => ({
  unpinEvidenceCid: jest.fn().mockResolvedValue(undefined),
}));

// milestone.ts also pulls in services/ipfsAudit.js -> services/db.js (real
// Prisma client) for the unrelated /unpin route. Stub the DB layer so these
// proposal-focused tests stay DB-free.
jest.mock("../services/db.js", () => ({
  prisma: { unpinnedCid: { create: jest.fn() } },
}));

const app = express();
app.use(express.json());
app.use("/api/milestone", milestoneRouter);

describe("Milestone proposal audit trail", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _clearProposalStore();
  });

  it("logs an audit entry when a milestone proposal is created", async () => {
    const res = await request(app)
      .post("/api/milestone/proposals")
      .send({ milestoneId: "m-1", evidenceCid: "bafy123" });

    expect(res.status).toBe(201);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "milestone.proposal_created",
        metadata: expect.objectContaining({
          proposalId: res.body.id,
          milestoneId: "m-1",
          evidenceCid: "bafy123",
        }),
      })
    );
  });

  it("logs an audit entry when a milestone proposal is rejected", async () => {
    const created = await request(app)
      .post("/api/milestone/proposals")
      .send({ milestoneId: "m-2", evidenceCid: "bafy456" });

    (logAudit as jest.Mock).mockClear();

    const res = await request(app)
      .post(`/api/milestone/proposals/${created.body.id}/reject`)
      .send({ reason: "Evidence does not match milestone" });

    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "milestone.proposal_rejected",
        metadata: expect.objectContaining({
          proposalId: created.body.id,
          reason: "Evidence does not match milestone",
        }),
      })
    );
  });

  it("does not log an audit entry when rejecting a non-existent proposal", async () => {
    const res = await request(app).post("/api/milestone/proposals/does-not-exist/reject").send({});

    expect(res.status).toBe(404);
    expect(logAudit).not.toHaveBeenCalled();
  });
});
