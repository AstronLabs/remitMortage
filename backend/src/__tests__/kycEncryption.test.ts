import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { encryptBuffer, decryptBuffer } from "../services/kmsEncryption";
import { kycRouter } from "../routes/kyc";

const ADMIN_KEY = "test-admin-key";

let storageDir: string;

jest.mock("../config.js", () => ({
  loadConfig: () => ({
    adminApiKey: "test-admin-key",
    kmsKeyVersions: { v1: "1".repeat(64), v2: "2".repeat(64) },
    kmsActiveKeyVersion: "v1",
    kycOperatorSecret: "test-operator-secret",
    kycAccessTokenTtlSeconds: 300,
  }),
}));

// The updated kyc.ts imports kycOcrStore → db.ts → PrismaClient.
// Mock db.ts so Prisma is never instantiated in these existing tests.
jest.mock("../services/db.js", () => ({
  prisma: {
    kycOcrResult: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

// Stub the OCR store so the upload route still works end-to-end without a DB.
// createOcrResult resolves to a minimal record; getOcrResult returns null
// (no OCR record for documents in these tests — preserves existing behavior).
jest.mock("../services/kycOcrStore.js", () => ({
  createOcrResult: jest.fn().mockResolvedValue({
    id: "ocr-stub",
    documentId: "stub-doc",
    applicantAddress: "",
    extractedName: null,
    nameConfirmed: false,
    extractedIdNumber: null,
    idNumberConfirmed: false,
    extractedAddress: null,
    addressConfirmed: false,
    ocrFailed: false,
    ocrError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  getOcrResult: jest.fn().mockResolvedValue(null),
  confirmOcrFields: jest.fn(),
  getUnconfirmedFields: jest.fn().mockReturnValue([]),
}));

describe("kmsEncryption envelope encryption", () => {
  it("round-trips a buffer through encrypt/decrypt", () => {
    const plaintext = Buffer.from("passport-scan-bytes-not-really-a-pdf");

    const envelope = encryptBuffer(plaintext);

    expect(envelope.keyVersion).toBe("v1");
    expect(envelope.ciphertext).not.toContain("passport-scan-bytes");
    expect(Buffer.from(envelope.ciphertext, "base64").toString("latin1")).not.toContain(
      "passport-scan-bytes"
    );

    const decrypted = decryptBuffer(envelope);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("produces different ciphertext for the same plaintext (fresh IV + DEK per call)", () => {
    const plaintext = Buffer.from("same content twice");

    const a = encryptBuffer(plaintext);
    const b = encryptBuffer(plaintext);

    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedDataKey).not.toBe(b.wrappedDataKey);
  });

  it("fails closed when the ciphertext is tampered with", () => {
    const envelope = encryptBuffer(Buffer.from("tamper me"));

    const tampered = Buffer.from(envelope.ciphertext, "base64");
    tampered[tampered.length - 1] ^= 0xff;

    expect(() =>
      decryptBuffer({ ...envelope, ciphertext: tampered.toString("base64") })
    ).toThrow();
  });
});

describe("KYC upload/decrypt routes", () => {
  let app: express.Express;
  const BORROWER_ADDRESS = "GBORROWERADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
  const PDF_BYTES = Buffer.from("%PDF-1.4 fake payroll stub contents");

  function borrowerToken(): string {
    return jwt.sign(
      { walletAddress: BORROWER_ADDRESS, network: "stellar" },
      process.env.JWT_SECRET || "default_jwt_secret"
    );
  }

  beforeAll(async () => {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "kyc-storage-"));
    process.env.KYC_STORAGE_DIR = storageDir;
  });

  afterAll(async () => {
    delete process.env.KYC_STORAGE_DIR;
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use("/api/kyc", kycRouter);
  });

  it("rejects an upload with no wallet auth (401)", async () => {
    const res = await request(app)
      .post(`/api/kyc/${BORROWER_ADDRESS}/upload`)
      .attach("document", PDF_BYTES, { filename: "payroll.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(401);
  });

  it("rejects an upload for a different address than the authenticated wallet (403)", async () => {
    const res = await request(app)
      .post(`/api/kyc/GSOMEOTHERADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX/upload`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .attach("document", PDF_BYTES, { filename: "payroll.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("rejects disallowed file types (400)", async () => {
    const res = await request(app)
      .post(`/api/kyc/${BORROWER_ADDRESS}/upload`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .attach("document", Buffer.from("<script>"), {
        filename: "payload.html",
        contentType: "text/html",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_file_type");
  });

  it("stores the document fully encrypted at rest and never leaks the raw bytes on disk", async () => {
    const res = await request(app)
      .post(`/api/kyc/${BORROWER_ADDRESS}/upload`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .attach("document", PDF_BYTES, { filename: "payroll.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(res.body.documentId).toBeDefined();

    const storedFile = path.join(storageDir, `${res.body.documentId}.json`);
    const raw = await fs.readFile(storedFile, "utf8");

    expect(raw).not.toContain("fake payroll stub contents");
    expect(raw).not.toContain(PDF_BYTES.toString("base64"));

    const parsed = JSON.parse(raw);
    expect(parsed.envelope.ciphertext).toBeDefined();
    expect(parsed.envelope.wrappedDataKey).toBeDefined();
  });

  it("blocks decryption without an operator API key (401)", async () => {
    const res = await request(app).get("/api/kyc/some-doc-id/decrypt");
    expect(res.status).toBe(401);
  });

  it("blocks decryption without a temporary access token even with a valid operator key (401)", async () => {
    const res = await request(app)
      .get("/api/kyc/some-doc-id/decrypt")
      .set("x-admin-api-key", ADMIN_KEY);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("full flow: upload -> issue temporary token -> decrypt returns the original bytes", async () => {
    const upload = await request(app)
      .post(`/api/kyc/${BORROWER_ADDRESS}/upload`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .attach("document", PDF_BYTES, { filename: "payroll.pdf", contentType: "application/pdf" });
    expect(upload.status).toBe(201);
    const { documentId } = upload.body;

    const tokenRes = await request(app)
      .post("/api/kyc/access-token")
      .set("x-admin-api-key", ADMIN_KEY)
      .send({ documentId, operatorId: "ops-1" });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.token).toBeDefined();

    const decryptRes = await request(app)
      .get(`/api/kyc/${documentId}/decrypt`)
      .set("x-admin-api-key", ADMIN_KEY)
      .set("Authorization", `Bearer ${tokenRes.body.token}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(decryptRes.status).toBe(200);
    expect(Buffer.compare(decryptRes.body as Buffer, PDF_BYTES)).toBe(0);
  });

  it("rejects a token that was issued for a different document (401)", async () => {
    const upload1 = await request(app)
      .post(`/api/kyc/${BORROWER_ADDRESS}/upload`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .attach("document", PDF_BYTES, { filename: "a.pdf", contentType: "application/pdf" });
    const upload2 = await request(app)
      .post(`/api/kyc/${BORROWER_ADDRESS}/upload`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .attach("document", Buffer.from("different document"), {
        filename: "b.pdf",
        contentType: "application/pdf",
      });

    const tokenRes = await request(app)
      .post("/api/kyc/access-token")
      .set("x-admin-api-key", ADMIN_KEY)
      .send({ documentId: upload1.body.documentId, operatorId: "ops-1" });

    const decryptRes = await request(app)
      .get(`/api/kyc/${upload2.body.documentId}/decrypt`)
      .set("x-admin-api-key", ADMIN_KEY)
      .set("Authorization", `Bearer ${tokenRes.body.token}`);

    expect(decryptRes.status).toBe(401);
  });
});
