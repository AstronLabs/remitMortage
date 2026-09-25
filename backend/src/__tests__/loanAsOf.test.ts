// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";

// Mock every dependency the loan router pulls in so we exercise only the
// GET /:id `asOf` branch.
jest.mock("../services/loanStore.js", () => ({
  createApplication: jest.fn(),
  getApplication: jest.fn(),
  getApplicationsByBorrower: jest.fn(),
  getPendingApplications: jest.fn(),
  updateApplication: jest.fn(),
  escrowTargetMetForAmount: jest.fn(),
}));
jest.mock("../services/loanHistory.js", () => ({
  reconstructLoanApplicationAt: jest.fn(),
}));
jest.mock("../services/notification.js", () => ({ queueNotification: jest.fn() }));
jest.mock("../jobs/kycExpiryReminder.js", () => ({ hasExpiredKycDocuments: jest.fn() }));
jest.mock("../services/db.js", () => ({ prisma: {} }));
jest.mock("../utils/fuzzyMatch.js", () => ({
  checkDuplicateApplicants: jest.fn(),
  logReviewerDecision: jest.fn(),
  ApplicantFields: {},
}));

import { loanRouter } from "../routes/loan.js";
import { getApplication } from "../services/loanStore.js";
import { reconstructLoanApplicationAt } from "../services/loanHistory.js";

const getApplicationMock = getApplication as jest.Mock;
const reconstructMock = reconstructLoanApplicationAt as jest.Mock;

const app = express();
app.use(express.json());
app.use("/api/loan", loanRouter);

const CURRENT = {
  id: "loan-1",
  borrowerAddress: "GA" + "A".repeat(54),
  amount: "1500",
  status: "Disbursing",
  reason: "funds released",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-20T18:15:00.000Z",
};

beforeEach(() => {
  jest.clearAllMocks();
  getApplicationMock.mockResolvedValue(CURRENT);
});

describe("GET /api/loan/:id", () => {
  it("returns the current record unchanged when asOf is omitted", async () => {
    const res = await request(app).get("/api/loan/loan-1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(CURRENT);
    expect(reconstructMock).not.toHaveBeenCalled();
  });

  it("returns the reconstructed historical state when asOf is supplied", async () => {
    const historical = { ...CURRENT, amount: "1000", status: "Pending", reason: undefined, updatedAt: "2026-01-01T00:00:00.000Z" };
    reconstructMock.mockResolvedValue(historical);

    const res = await request(app)
      .get("/api/loan/loan-1")
      .query({ asOf: "2026-01-02T00:00:00.000Z" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "Pending", amount: "1000", asOf: "2026-01-02T00:00:00.000Z" });
    expect(reconstructMock).toHaveBeenCalledWith(
      "loan-1",
      new Date("2026-01-02T00:00:00.000Z"),
      expect.objectContaining({ fallbackSeed: expect.any(Object) }),
    );
  });

  it("rejects a malformed asOf timestamp with 400", async () => {
    const res = await request(app).get("/api/loan/loan-1").query({ asOf: "not-a-date" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_asof");
    expect(reconstructMock).not.toHaveBeenCalled();
  });

  it("404s an asOf query for a loan that does not exist", async () => {
    getApplicationMock.mockResolvedValueOnce(null);
    const res = await request(app).get("/api/loan/missing").query({ asOf: "2026-01-02T00:00:00.000Z" });
    expect(res.status).toBe(404);
  });

  it("404s when the loan did not exist yet at the requested instant", async () => {
    reconstructMock.mockResolvedValueOnce(null);
    const res = await request(app).get("/api/loan/loan-1").query({ asOf: "2025-01-01T00:00:00.000Z" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found_asof");
  });
});
