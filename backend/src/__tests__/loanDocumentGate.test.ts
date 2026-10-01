import express from "express";
import request from "supertest";
import { loanRouter } from "../routes/loan.js";
import { listApplicantDocuments } from "../services/kycStorage.js";
import { createApplication } from "../services/loanStore.js";

jest.mock("../services/kycStorage.js", () => ({
  listApplicantDocuments: jest.fn(),
}));
jest.mock("../services/loanStore.js", () => ({
  createApplication: jest.fn(),
  getApplication: jest.fn(),
  getApplicationsByBorrower: jest.fn(),
  getPendingApplications: jest.fn(),
  updateApplication: jest.fn(),
  escrowTargetMetForAmount: jest.fn(() => true),
}));
jest.mock("../services/notification.js", () => ({ queueNotification: jest.fn() }));

const app = express();
app.use(express.json());
app.use("/api/loan", loanRouter);

const address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const mockDocuments = listApplicantDocuments as jest.Mock;
const mockCreateApplication = createApplication as jest.Mock;

describe("loan application required-document gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDocuments.mockResolvedValue([]);
  });

  it("blocks submission and lists outstanding required documents", async () => {
    const response = await request(app)
      .post("/api/loan/apply")
      .send({ borrowerAddress: address, amount: 1000, loanType: "purchase" });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("required_documents_incomplete");
    expect(response.body.unacceptedDocuments).toEqual([
      { documentType: "identity", status: "Missing", reviewMessage: undefined },
      { documentType: "income", status: "Missing", reviewMessage: undefined },
      { documentType: "bank_statement", status: "Missing", reviewMessage: undefined },
      { documentType: "property_contract", status: "Missing", reviewMessage: undefined },
    ]);
    expect(mockCreateApplication).not.toHaveBeenCalled();
  });

  it("requires the latest uploaded version of each required type to be accepted", async () => {
    const uploadedAt = "2026-01-01T00:00:00.000Z";
    mockDocuments.mockResolvedValue([
      ...["identity", "income", "bank_statement", "property_contract"].map((documentType) => ({
        documentId: `${documentType}-new`, applicantAddress: address, documentType,
        status: "Accepted", originalName: `${documentType}.pdf`, mimeType: "application/pdf", uploadedAt,
      })),
      { documentId: "identity-newer", applicantAddress: address, documentType: "identity", status: "Rejected", originalName: "new-id.pdf", mimeType: "application/pdf", uploadedAt: "2026-02-01T00:00:00.000Z" },
    ]);

    const response = await request(app)
      .post("/api/loan/apply")
      .send({ borrowerAddress: address, amount: 1000, loanType: "purchase" });

    expect(response.status).toBe(400);
    expect(response.body.unacceptedDocuments).toEqual([
      { documentType: "identity", status: "Rejected", reviewMessage: undefined },
    ]);
    expect(mockCreateApplication).not.toHaveBeenCalled();
  });

  it("creates an application once all required document statuses are accepted", async () => {
    mockDocuments.mockResolvedValue(["identity", "income", "bank_statement", "property_contract"].map((documentType) => ({
      documentId: documentType, applicantAddress: address, documentType,
      status: "Accepted", originalName: `${documentType}.pdf`, mimeType: "application/pdf",
      uploadedAt: "2026-01-01T00:00:00.000Z",
    })));
    mockCreateApplication.mockResolvedValue({ id: "app-1", borrowerAddress: address, amount: "1000" });

    const response = await request(app)
      .post("/api/loan/apply")
      .send({ borrowerAddress: address, amount: 1000, loanType: "purchase" });

    expect(response.status).toBe(201);
    expect(mockCreateApplication).toHaveBeenCalledWith(address, "1000", "purchase");
  });
});
