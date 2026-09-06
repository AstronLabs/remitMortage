import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import app from "../index";
import { prisma } from "../services/db";
import { getBackendSigningKeypair, generateVerificationProof } from "../services/proof";

jest.mock("../services/db", () => ({
  prisma: {
    verificationResult: {
      findUnique: jest.fn(),
    },
  },
}));
// Provide other helper exports expected by app startup
(jest.requireMock("../services/db") as any).loadIndexerState = jest.fn(async () => ({ lastProcessedLedger: 0, cursor: null }));

describe("Proof Generator Service", () => {
  const mockReportId = "test-report-123";
  const mockDbResult = {
    id: mockReportId,
    eligible: true,
    reportHash: "test-hash",
    analyzedAt: new Date("2024-01-01T00:00:00Z"),
    applicant: {
      stellarAddress: "GBXTESTADDRESS",
      creditScore: 800,
      taxId: "SENSITIVE_DATA",
      monthlyIncome: "SENSITIVE_DATA_2",
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should generate a valid Ed25519 signature verifiable by the public key", async () => {
    (prisma.verificationResult.findUnique as jest.Mock).mockResolvedValue(mockDbResult);

    const proof = await generateVerificationProof(mockReportId);

    expect(proof.payload.reportId).toBe(mockReportId);
    expect(proof.payload.walletAddress).toBe("GBXTESTADDRESS");
    
    // Ensure sensitive fields are excluded
    expect((proof.payload as any).taxId).toBeUndefined();
    expect((proof.payload as any).monthlyIncome).toBeUndefined();

    // Verify cryptographic signature
    const keypair = Keypair.fromPublicKey(proof.publicKey);
    const messageBytes = Buffer.from(JSON.stringify(proof.payload), "utf8");
    const signatureBytes = Buffer.from(proof.signature, "hex");

    const isValid = keypair.verify(messageBytes, signatureBytes);
    expect(isValid).toBe(true);
  });

  it("should throw an error if the report is not found", async () => {
    (prisma.verificationResult.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(generateVerificationProof("invalid-id")).rejects.toThrow(/not found/i);
  });
});

describe("POST /api/verify/proof Endpoint", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should return 400 if reportId is missing", async () => {
    const res = await request(app).post("/api/verify/proof").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_field");
  });

  it("should return 404 if report is not found", async () => {
    (prisma.verificationResult.findUnique as jest.Mock).mockResolvedValue(null);
    const res = await request(app).post("/api/verify/proof").send({ reportId: "invalid-id" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("should return 200 and the proof certificate on success", async () => {
    (prisma.verificationResult.findUnique as jest.Mock).mockResolvedValue({
      id: "report-123",
      eligible: true,
      reportHash: "hash-123",
      analyzedAt: new Date(),
      applicant: {
        stellarAddress: "G12345",
        creditScore: 750,
      }
    });

    const res = await request(app).post("/api/verify/proof").send({ reportId: "report-123" });
    
    expect(res.status).toBe(200);
    expect(res.body.payload).toBeDefined();
    expect(res.body.signature).toBeDefined();
    expect(res.body.publicKey).toBeDefined();
    expect(res.body.payload.walletAddress).toBe("G12345");
  });
});
