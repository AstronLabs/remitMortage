// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { userRouter } from "../routes/user.js";
import { getUserDataExport, processUserDataDeletion } from "../services/db.js";

// Mock the db service
jest.mock("../services/db.js", () => ({
  getUserDataExport: jest.fn(),
  processUserDataDeletion: jest.fn(),
}));

const TEST_JWT_SECRET = "default_jwt_secret";
const TEST_WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function generateTestToken(walletAddress = TEST_WALLET) {
  return jwt.sign({ walletAddress, network: "testnet" }, TEST_JWT_SECRET, { expiresIn: "1h" });
}

const app = express();
app.use(express.json());
app.use("/api/user", userRouter);

describe("User Data Protection API Routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /api/user/data-export", () => {
    it("rejects unauthorized request without token", async () => {
      const res = await request(app).get("/api/user/data-export");
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("unauthorized");
    });

    it("returns complete user data export archive for authenticated user", async () => {
      const mockExportData = {
        exportedAt: new Date().toISOString(),
        user: { walletAddress: TEST_WALLET },
        applicantProfile: {
          id: "app-123",
          verificationStatus: "ELIGIBLE",
          creditScore: 750,
          taxId: "TX-12345",
          monthlyIncome: "5000",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        kycDocuments: [
          { id: "doc-1", documentId: "key-1", originalName: "passport.pdf", mimeType: "application/pdf" },
        ],
        verificationResults: [{ id: "ver-1", eligible: true, totalPayments: 12, totalVolume: 1000 }],
        loanApplications: [{ id: "loan-1", principal: 5000, status: "Approved" }],
        borrowerCredentials: [{ id: "cred-1", did: "did:stellar:" + TEST_WALLET }],
        notificationPreferences: { email: "user@example.com", emailAlerts: true },
        onChainFinancialActivity: {
          stellarAddress: TEST_WALLET,
          escrowBalance: "1000",
          loanOutstanding: "5000",
          totalDeposited: "1000",
          totalDisbursed: "5000",
          totalRepaid: "0",
          deposits: [{ id: "dep-1", amount: "1000", ledger: 100 }],
          withdrawals: [],
          disbursements: [{ id: "disb-1", amount: "5000", ledger: 105 }],
          repayments: [],
        },
        workspaceMemberships: [{ workspaceId: "ws-1", workspaceName: "Main", role: "OWNER" }],
        workspaceInvitations: [],
        auditLogs: [{ id: "audit-1", action: "login", ipAddress: "127.0.0.1" }],
        deletionRequests: [],
      };

      (getUserDataExport as jest.Mock).mockResolvedValue(mockExportData);

      const token = generateTestToken();
      const res = await request(app)
        .get("/api/user/data-export")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.header["content-type"]).toContain("application/json");
      expect(res.header["content-disposition"]).toContain("attachment; filename=");
      expect(res.body).toEqual(mockExportData);
      expect(getUserDataExport).toHaveBeenCalledWith(TEST_WALLET);
    });

    it("handles internal errors during data export compilation", async () => {
      (getUserDataExport as jest.Mock).mockRejectedValue(new Error("DB Connection Error"));

      const token = generateTestToken();
      const res = await request(app)
        .get("/api/user/data-export")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("internal_error");
    });
  });

  describe("POST /api/user/data-deletion", () => {
    it("rejects unauthorized request without token", async () => {
      const res = await request(app).post("/api/user/data-deletion").send({ confirm: true });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("unauthorized");
    });

    it("rejects request if confirm flag is false", async () => {
      const token = generateTestToken();
      const res = await request(app)
        .post("/api/user/data-deletion")
        .set("Authorization", `Bearer ${token}`)
        .send({ confirm: false });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("processes deletion request and anonymizes user data when confirmed", async () => {
      const mockResult = {
        id: "del-req-123",
        walletAddress: TEST_WALLET,
        status: "COMPLETED",
        requestedAt: new Date().toISOString(),
        processedAt: new Date().toISOString(),
        anonymizedAt: new Date().toISOString(),
        details: {
          anonymizedFields: ["taxId", "monthlyIncome", "creditScore", "kycDocuments", "notificationPreferences", "auditLogs"],
          anonymizedOnChainRecords: ["escrowBalance", "loanOutstanding", "escrowDeposits", "escrowWithdrawals", "loanDisbursements", "loanRepayments"],
          complianceNotice: "Off-chain PII has been scrubbed. Immutable on-chain transaction metrics are retained anonymously per regulatory standards.",
        },
      };

      (processUserDataDeletion as jest.Mock).mockResolvedValue(mockResult);

      const token = generateTestToken();
      const res = await request(app)
        .post("/api/user/data-deletion")
        .set("Authorization", `Bearer ${token}`)
        .send({ confirm: true, reason: "Self-service compliance request" });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain("Data deletion and anonymization request processed successfully");
      expect(res.body.request.id).toBe("del-req-123");
      expect(res.body.request.status).toBe("COMPLETED");
      expect(processUserDataDeletion).toHaveBeenCalledWith(TEST_WALLET, "Self-service compliance request");
    });
  });
});
