/**
 * KYC OCR auto-fill tests — issue #529-equivalent (KYC OCR).
 *
 * Test strategy
 * ─────────────
 * • The OCR service is injectable (setOcrProvider / extractKycFields).
 *   Tests install a mock provider that returns pre-canned results so no real
 *   document bytes or OCR binary is needed.
 *
 * • kycOcrStore functions are mocked at the module level so no real Prisma
 *   client or database is needed.  This mirrors the pattern used for
 *   scheduler.test.ts (prisma mock) and kycEncryption.test.ts (real FS).
 *
 * • kycStorage.storeEncryptedDocument is mocked to return a deterministic
 *   documentId without touching the filesystem.
 *
 * • The existing KYC upload auth/encryption tests in kycEncryption.test.ts
 *   are NOT duplicated here.
 */

import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { kycRouter } from "../routes/kyc.js";
import { setOcrProvider, OcrProvider } from "../services/ocrService.js";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock("../config.js", () => ({
  loadConfig: () => ({
    adminApiKey: "test-admin-key",
    kmsKeyVersions: { v1: "1".repeat(64) },
    kmsActiveKeyVersion: "v1",
    kycOperatorSecret: "test-operator-secret",
    kycAccessTokenTtlSeconds: 300,
  }),
}));

// Mock db.ts so Prisma client is never instantiated in tests
jest.mock("../services/db.js", () => ({
  prisma: {
    kycOcrResult: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

// Mock the OCR store — we control all DB interactions here
jest.mock("../services/kycOcrStore.js", () => ({
  createOcrResult: jest.fn(),
  getOcrResult: jest.fn(),
  confirmOcrFields: jest.fn(),
  getUnconfirmedFields: jest.requireActual("../services/kycOcrStore.js").getUnconfirmedFields,
}));

// Mock kycStorage so no filesystem writes happen
jest.mock("../services/kycStorage.js", () => ({
  storeEncryptedDocument: jest.fn(),
  getEncryptedDocument: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Import mocked modules after jest.mock declarations
// ---------------------------------------------------------------------------

import {
  createOcrResult,
  getOcrResult,
  confirmOcrFields,
  getUnconfirmedFields,
} from "../services/kycOcrStore.js";

import {
  storeEncryptedDocument,
} from "../services/kycStorage.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const BORROWER_ADDRESS = "GBORROWERADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const OTHER_ADDRESS    = "GOTHERWALLETADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const DOCUMENT_ID      = "doc-test-uuid-001";

function borrowerToken(address = BORROWER_ADDRESS): string {
  return jwt.sign(
    { walletAddress: address, network: "stellar" },
    process.env.JWT_SECRET || "default_jwt_secret"
  );
}

const PDF_BYTES = Buffer.from(
  "%PDF-1.4\nName: John Doe\nPassport No: AB123456\nAddress: 12 Baker Street, London SW1A 1AA\n"
);

const IMAGE_BYTES = Buffer.from("PNG\x89PNG\r\n\x1a\n");

// OCR result shapes reused across tests
const FULL_OCR_RESULT = {
  fields: { name: "John Doe", idNumber: "AB123456", address: "12 Baker Street, London SW1A 1AA" },
  success: true,
  error: null,
};

const PARTIAL_OCR_RESULT = {
  fields: { name: "Jane Smith", idNumber: null, address: null },
  success: true,
  error: null,
};

const FAILED_OCR_RESULT = {
  fields: { name: null, idNumber: null, address: null },
  success: false,
  error: "Could not decode document",
};

const EMPTY_OCR_RESULT = {
  fields: { name: null, idNumber: null, address: null },
  success: true,
  error: null,
};

// ---------------------------------------------------------------------------
// Full OCR record returned by createOcrResult / getOcrResult mocks
// ---------------------------------------------------------------------------

function ocrRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "ocr-record-1",
    documentId: DOCUMENT_ID,
    applicantAddress: BORROWER_ADDRESS,
    extractedName: FULL_OCR_RESULT.fields.name,
    nameConfirmed: false,
    extractedIdNumber: FULL_OCR_RESULT.fields.idNumber,
    idNumberConfirmed: false,
    extractedAddress: FULL_OCR_RESULT.fields.address,
    addressConfirmed: false,
    ocrFailed: false,
    ocrError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/kyc", kycRouter);
  return app;
}

/** Install a mock OCR provider that always returns `result`. */
function mockOcrProvider(result: typeof FULL_OCR_RESULT): void {
  const provider: OcrProvider = {
    extract: jest.fn().mockResolvedValue(result),
  };
  setOcrProvider(provider);
}

// ---------------------------------------------------------------------------
// Suite 1 — OCR extraction and auto-fill during upload
// ---------------------------------------------------------------------------

describe("KYC OCR: upload extracts and stores fields", () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();

    // storeEncryptedDocument returns a stable record
    (storeEncryptedDocument as jest.Mock).mockResolvedValue({
      documentId: DOCUMENT_ID,
      uploadedAt: new Date().toISOString(),
    });
  });

  it("extracts name, idNumber, and address from a text-layer PDF", async () => {
    mockOcrProvider(FULL_OCR_RESULT);
    (createOcrResult as jest.Mock).mockResolvedValue(ocrRecord());

    const res = await request(app)
      .post(`/api/kyc/${BORROWER_ADDRESS}/upload`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .attach("document", PDF_BYTES, { filename: "passport.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(res.body.documentId).toBe(DOCUMENT_ID);

    // All three fields are present and marked unconfirmed
    expect(res.body.ocr.extractedName).toBe("John Doe");
    expect(res.body.ocr.nameConfirmed).toBe(false);
    expect(res.body.ocr.extractedIdNumber).toBe("AB123456");
    expect(res.body.ocr.idNumberConfirmed).toBe(false);
    expect(res.body.ocr.extractedAddress).toBe("12 Baker Street, London SW1A 1AA");
    expect(res.body.ocr.addressConfirmed).toBe(false);
    expect(res.body.ocr.ocrFailed).toBe(false);
  });

  it("auto-fills only the fields OCR could extract (partial extraction)", async () => {
    mockOcrProvider(PARTIAL_OCR_RESULT);
    (createOcrResult as jest.Mock).mockResolvedValue(
      ocrRecord({
        extractedName: "Jane Smith",
        extractedIdNumber: null,
        extractedAddress: null,
      })
    );

    const res = await request(app)
      .post(`/api/kyc/${BORROWER_ADDRESS}/upload`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .attach("document", PDF_BYTES, { filename: "id.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(res.body.ocr.extractedName).toBe("Jane Smith");
    expect(res.body.ocr.nameConfirmed).toBe(false);
    // Fields OCR could not extract are null — manual entry is expected
    expect(res.body.ocr.extractedIdNumber).toBeNull();
    expect(res.body.ocr.extractedAddress).toBeNull();
    expect(res.body.ocr.ocrFailed).toBe(false);
  });

  it("returns ocrFailed=true when OCR throws an error", async () => {
    mockOcrProvider(FAILED_OCR_RESULT);
    (createOcrResult as jest.Mock).mockResolvedValue(
      ocrRecord({ extractedName: null, extractedIdNumber: null, extractedAddress: null, ocrFailed: true })
    );

    const res = await request(app)
      .post(`/api/kyc/${BORROWER_ADDRESS}/upload`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .attach("document", IMAGE_BYTES, { filename: "scan.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(res.body.ocr.ocrFailed).toBe(true);
    // No extracted fields when OCR failed
    expect(res.body.ocr.extractedName).toBeNull();
  });

  it("upload succeeds even when the OCR store write fails (non-fatal)", async () => {
    mockOcrProvider(FULL_OCR_RESULT);
    // Simulate OCR persistence failure
    (createOcrResult as jest.Mock).mockRejectedValue(new Error("DB connection lost"));

    const res = await request(app)
      .post(`/api/kyc/${BORROWER_ADDRESS}/upload`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .attach("document", PDF_BYTES, { filename: "passport.pdf", contentType: "application/pdf" });

    // Upload must still succeed — OCR store failure is non-fatal
    expect(res.status).toBe(201);
    expect(res.body.documentId).toBe(DOCUMENT_ID);
    expect(res.body.ocr.ocrFailed).toBe(true); // fallback when store fails
  });

  it("createOcrResult is called with the correct documentId and address", async () => {
    mockOcrProvider(FULL_OCR_RESULT);
    (createOcrResult as jest.Mock).mockResolvedValue(ocrRecord());

    await request(app)
      .post(`/api/kyc/${BORROWER_ADDRESS}/upload`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .attach("document", PDF_BYTES, { filename: "passport.pdf", contentType: "application/pdf" });

    expect(createOcrResult).toHaveBeenCalledWith(
      DOCUMENT_ID,
      BORROWER_ADDRESS,
      expect.objectContaining({ success: true })
    );
  });

  it("existing upload auth is preserved: 403 when wallet does not match path address", async () => {
    mockOcrProvider(FULL_OCR_RESULT);

    const res = await request(app)
      .post(`/api/kyc/${OTHER_ADDRESS}/upload`)
      .set("Authorization", `Bearer ${borrowerToken(BORROWER_ADDRESS)}`)
      .attach("document", PDF_BYTES, { filename: "passport.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
    expect(createOcrResult).not.toHaveBeenCalled();
  });

  it("existing upload type check preserved: 400 for unsupported file type", async () => {
    mockOcrProvider(FULL_OCR_RESULT);

    const res = await request(app)
      .post(`/api/kyc/${BORROWER_ADDRESS}/upload`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .attach("document", Buffer.from("<script>"), { filename: "hack.html", contentType: "text/html" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_file_type");
    expect(createOcrResult).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Confirmation flow
// ---------------------------------------------------------------------------

describe("KYC OCR: confirmation flow", () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it("confirms all three fields when requested", async () => {
    (getOcrResult as jest.Mock).mockResolvedValue(ocrRecord());
    (confirmOcrFields as jest.Mock).mockResolvedValue(
      ocrRecord({ nameConfirmed: true, idNumberConfirmed: true, addressConfirmed: true })
    );

    const res = await request(app)
      .post(`/api/kyc/${DOCUMENT_ID}/confirm`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .send({ confirmName: true, confirmIdNumber: true, confirmAddress: true });

    expect(res.status).toBe(200);
    expect(res.body.nameConfirmed).toBe(true);
    expect(res.body.idNumberConfirmed).toBe(true);
    expect(res.body.addressConfirmed).toBe(true);
    expect(res.body.allConfirmed).toBe(true);
    expect(res.body.unconfirmedFields).toHaveLength(0);
  });

  it("confirms a single field while leaving others unconfirmed", async () => {
    (getOcrResult as jest.Mock).mockResolvedValue(ocrRecord());
    (confirmOcrFields as jest.Mock).mockResolvedValue(
      ocrRecord({ nameConfirmed: true, idNumberConfirmed: false, addressConfirmed: false })
    );

    const res = await request(app)
      .post(`/api/kyc/${DOCUMENT_ID}/confirm`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .send({ confirmName: true });

    expect(res.status).toBe(200);
    expect(res.body.nameConfirmed).toBe(true);
    expect(res.body.idNumberConfirmed).toBe(false);
    expect(res.body.allConfirmed).toBe(false);
    expect(res.body.unconfirmedFields).toEqual(
      expect.arrayContaining(["idNumber", "address"])
    );
  });

  it("returns 400 when no confirmation fields are supplied", async () => {
    const res = await request(app)
      .post(`/api/kyc/${DOCUMENT_ID}/confirm`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_field");
  });

  it("returns 404 when the OCR record does not exist", async () => {
    (getOcrResult as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/kyc/${DOCUMENT_ID}/confirm`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .send({ confirmName: true });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("ocr_result_not_found");
  });

  it("returns 403 when the authenticated wallet does not own the document", async () => {
    (getOcrResult as jest.Mock).mockResolvedValue(ocrRecord()); // owned by BORROWER_ADDRESS

    const res = await request(app)
      .post(`/api/kyc/${DOCUMENT_ID}/confirm`)
      .set("Authorization", `Bearer ${borrowerToken(OTHER_ADDRESS)}`)
      .send({ confirmName: true });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
    expect(confirmOcrFields).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — Submission gate
// ---------------------------------------------------------------------------

describe("KYC OCR: submission rejected when fields are unconfirmed", () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it("rejects submission when all three extracted fields are unconfirmed", async () => {
    (getOcrResult as jest.Mock).mockResolvedValue(ocrRecord()); // all unconfirmed

    const res = await request(app)
      .post(`/api/kyc/${DOCUMENT_ID}/submit`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unconfirmed_ocr_fields");
    expect(res.body.unconfirmedFields).toEqual(
      expect.arrayContaining(["name", "idNumber", "address"])
    );
  });

  it("rejects submission when only some fields remain unconfirmed", async () => {
    (getOcrResult as jest.Mock).mockResolvedValue(
      ocrRecord({ nameConfirmed: true, idNumberConfirmed: false, addressConfirmed: true })
    );

    const res = await request(app)
      .post(`/api/kyc/${DOCUMENT_ID}/submit`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.unconfirmedFields).toEqual(["idNumber"]);
  });

  it("accepts submission when all extracted fields are confirmed", async () => {
    (getOcrResult as jest.Mock).mockResolvedValue(
      ocrRecord({ nameConfirmed: true, idNumberConfirmed: true, addressConfirmed: true })
    );

    const res = await request(app)
      .post(`/api/kyc/${DOCUMENT_ID}/submit`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.submitted).toBe(true);
  });

  it("accepts submission when OCR failed (manual-entry flow unchanged)", async () => {
    // When OCR could not extract any fields — manual entry path
    (getOcrResult as jest.Mock).mockResolvedValue(
      ocrRecord({
        extractedName: null,
        extractedIdNumber: null,
        extractedAddress: null,
        ocrFailed: true,
      })
    );

    const res = await request(app)
      .post(`/api/kyc/${DOCUMENT_ID}/submit`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.submitted).toBe(true);
  });

  it("accepts submission when no OCR record exists (pre-OCR documents)", async () => {
    // Documents uploaded before OCR was introduced have no KycOcrResult row
    (getOcrResult as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/kyc/${DOCUMENT_ID}/submit`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.submitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — getUnconfirmedFields unit tests (pure logic, no HTTP)
// ---------------------------------------------------------------------------

describe("getUnconfirmedFields", () => {
  it("returns all three fields when none are confirmed", () => {
    const rec = ocrRecord();
    expect(getUnconfirmedFields(rec)).toEqual(["name", "idNumber", "address"]);
  });

  it("returns only the unconfirmed fields when some are confirmed", () => {
    const rec = ocrRecord({ nameConfirmed: true });
    expect(getUnconfirmedFields(rec)).toEqual(["idNumber", "address"]);
  });

  it("returns empty array when all fields are confirmed", () => {
    const rec = ocrRecord({
      nameConfirmed: true,
      idNumberConfirmed: true,
      addressConfirmed: true,
    });
    expect(getUnconfirmedFields(rec)).toHaveLength(0);
  });

  it("does not require confirmation for null fields (OCR did not extract them)", () => {
    const rec = ocrRecord({
      extractedName: "Alice",
      nameConfirmed: false,
      extractedIdNumber: null,   // not extracted — no confirmation needed
      extractedAddress: null,    // not extracted — no confirmation needed
    });
    expect(getUnconfirmedFields(rec)).toEqual(["name"]);
  });

  it("returns empty array when ocrFailed with all null fields", () => {
    const rec = ocrRecord({
      extractedName: null,
      extractedIdNumber: null,
      extractedAddress: null,
      ocrFailed: true,
    });
    expect(getUnconfirmedFields(rec)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — RegexOcrProvider (real extraction logic)
// ---------------------------------------------------------------------------

import { RegexOcrProvider } from "../services/ocrService.js";

describe("RegexOcrProvider", () => {
  const provider = new RegexOcrProvider();

  it("extracts name, idNumber, and address from a labelled text document", async () => {
    const text = [
      "Name: John Doe",
      "Passport No: AB123456",
      "Address: 12 Baker Street, London SW1A 1AA",
    ].join("\n");
    const result = await provider.extract(Buffer.from(text), "application/pdf");
    expect(result.success).toBe(true);
    expect(result.fields.name).toBe("John Doe");
    expect(result.fields.idNumber).toBe("AB123456");
    expect(result.fields.address).toMatch(/Baker Street/);
  });

  it("returns success=true with null fields when nothing matches", async () => {
    const result = await provider.extract(Buffer.from("random bytes"), "application/pdf");
    expect(result.success).toBe(true);
    expect(result.fields.name).toBeNull();
    expect(result.fields.idNumber).toBeNull();
    expect(result.fields.address).toBeNull();
  });

  it("handles partial extraction gracefully", async () => {
    const text = "Full Name: Jane Smith\nSome unrelated content here";
    const result = await provider.extract(Buffer.from(text), "image/jpeg");
    expect(result.success).toBe(true);
    expect(result.fields.name).toBe("Jane Smith");
    expect(result.fields.idNumber).toBeNull();
    expect(result.fields.address).toBeNull();
  });

  it("extracts ID number from labelled Passport Number field", async () => {
    const text = "Passport Number: XY987654\nHolder: Bob Jones";
    const result = await provider.extract(Buffer.from(text), "application/pdf");
    expect(result.success).toBe(true);
    expect(result.fields.idNumber).toBe("XY987654");
  });

  it("returns success=false on provider error (Buffer decode failure simulation)", async () => {
    // Force a throw by passing an object that will cause toString to throw
    const badBuffer = {
      toString: () => { throw new Error("decode error"); },
    } as unknown as Buffer;
    const result = await provider.extract(badBuffer, "application/pdf");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/decode error/);
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — OCR GET endpoint
// ---------------------------------------------------------------------------

describe("KYC OCR: GET /:documentId/ocr", () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it("returns OCR result with unconfirmedFields list", async () => {
    (getOcrResult as jest.Mock).mockResolvedValue(ocrRecord());

    const res = await request(app)
      .get(`/api/kyc/${DOCUMENT_ID}/ocr`)
      .set("Authorization", `Bearer ${borrowerToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.extractedName).toBe("John Doe");
    expect(res.body.unconfirmedFields).toEqual(
      expect.arrayContaining(["name", "idNumber", "address"])
    );
    expect(res.body.allConfirmed).toBe(false);
  });

  it("returns 404 when no OCR record exists", async () => {
    (getOcrResult as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/kyc/${DOCUMENT_ID}/ocr`)
      .set("Authorization", `Bearer ${borrowerToken()}`);

    expect(res.status).toBe(404);
  });

  it("returns 403 for a different wallet address", async () => {
    (getOcrResult as jest.Mock).mockResolvedValue(ocrRecord());

    const res = await request(app)
      .get(`/api/kyc/${DOCUMENT_ID}/ocr`)
      .set("Authorization", `Bearer ${borrowerToken(OTHER_ADDRESS)}`);

    expect(res.status).toBe(403);
  });
});
