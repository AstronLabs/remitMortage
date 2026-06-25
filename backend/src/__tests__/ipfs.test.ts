import axios from "axios";

jest.mock("axios");
jest.mock("../config.js", () => ({
  loadConfig: () => ({
    port: 4000,
    stellarNetwork: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    escrowContractId: "",
    lendingPoolContractId: "",
    usdcTokenId: "",
    pinataApiKey: "test-api-key",
    pinataSecretApiKey: "test-secret-key",
    smtpHost: "localhost",
    smtpPort: 587,
    smtpUser: "",
    smtpPass: "",
    smtpFrom: "no-reply@remitmortgage.com",
    webhookSecret: "default_signing_secret_key",
  }),
}));
jest.mock("../services/db.js", () => ({
  prisma: {
    unpinnedCid: {
      create: jest.fn(),
    },
  },
}));

import express from "express";
import request from "supertest";
import { milestoneRouter } from "../routes/milestone.js";
import { unpinFileFromIPFS } from "../services/ipfs.js";
import { unpinEvidenceCid } from "../services/ipfsCleanup.js";
import { prisma } from "../services/db.js";
import {
  _clearProposalStore,
  createProposal,
  getProposal,
} from "../services/milestoneProposalStore.js";

const mockedAxios = axios as jest.Mocked<typeof axios>;

const app = express();
app.use(express.json());
app.use("/api/milestone", milestoneRouter);

describe("IPFS unpinning", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _clearProposalStore();
  });

  describe("unpinFileFromIPFS", () => {
    it("calls Pinata API with the correct CID", async () => {
      const cid = "QmTestEvidenceHash123";
      mockedAxios.delete.mockResolvedValue({ status: 200, data: {} });

      const result = await unpinFileFromIPFS(cid);

      expect(mockedAxios.delete).toHaveBeenCalledWith(
        `https://api.pinata.cloud/pinning/unpin/${encodeURIComponent(cid)}`,
        {
          headers: {
            pinata_api_key: "test-api-key",
            pinata_secret_api_key: "test-secret-key",
          },
        }
      );
      expect(result).toEqual({ status: 200, cid });
    });
  });

  describe("DELETE /api/milestone/unpin/:cid", () => {
    it("unpins via Pinata and records audit log on success", async () => {
      const cid = "QmUnpinEndpointTest";
      mockedAxios.delete.mockResolvedValue({ status: 200, data: {} });
      (prisma.unpinnedCid.create as jest.Mock).mockResolvedValue({
        id: "audit-1",
        cid,
        success: true,
        pinataStatus: 200,
      });

      const response = await request(app).delete(`/api/milestone/unpin/${cid}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ cid, status: 200 });
      expect(prisma.unpinnedCid.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          cid,
          success: true,
          pinataStatus: 200,
        }),
      });
    });
  });

  describe("POST /api/milestone/proposals/:id/reject", () => {
    it("triggers unpin and audit log when a proposal is rejected", async () => {
      const proposal = createProposal("milestone-42", "QmRejectedEvidence");
      mockedAxios.delete.mockResolvedValue({ status: 200, data: {} });
      (prisma.unpinnedCid.create as jest.Mock).mockResolvedValue({
        id: "audit-2",
        cid: proposal.evidenceCid,
        proposalId: proposal.id,
        success: true,
      });

      const response = await request(app)
        .post(`/api/milestone/proposals/${proposal.id}/reject`)
        .send({ reason: "Evidence insufficient" });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("Rejected");
      expect(response.body.reason).toBe("Evidence insufficient");

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockedAxios.delete).toHaveBeenCalledWith(
        `https://api.pinata.cloud/pinning/unpin/${encodeURIComponent(proposal.evidenceCid)}`,
        expect.any(Object)
      );
      expect(prisma.unpinnedCid.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          cid: proposal.evidenceCid,
          proposalId: proposal.id,
          success: true,
          pinataStatus: 200,
        }),
      });

      const updated = getProposal(proposal.id);
      expect(updated?.status).toBe("Rejected");
    });

    it("returns 400 when proposal is not Open", async () => {
      const proposal = createProposal("milestone-99", "QmAlreadyRejected");
      await request(app).post(`/api/milestone/proposals/${proposal.id}/reject`);

      const secondReject = await request(app).post(
        `/api/milestone/proposals/${proposal.id}/reject`
      );

      expect(secondReject.status).toBe(400);
      expect(secondReject.body.error).toBe("invalid_state");
    });
  });

  describe("unpinEvidenceCid", () => {
    it("logs a warning and audit failure without throwing when Pinata unpin fails", async () => {
      const warnSpy = jest.spyOn(require("../utils/logger").default, "warn").mockImplementation(() => {});
      mockedAxios.delete.mockRejectedValue({
        response: { data: { error: { details: "Not pinned" } } },
        message: "Request failed",
      });
      (prisma.unpinnedCid.create as jest.Mock).mockResolvedValue({
        id: "audit-fail",
        success: false,
      });

      await expect(unpinEvidenceCid("QmFailCID", "proposal-fail")).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[IPFSCleanup] Failed to unpin CID QmFailCID"),
        expect.any(Object)
      );
      expect(prisma.unpinnedCid.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          cid: "QmFailCID",
          proposalId: "proposal-fail",
          success: false,
          error: expect.stringContaining("Failed to unpin file from IPFS"),
        }),
      });

      warnSpy.mockRestore();
    });
  });
});
