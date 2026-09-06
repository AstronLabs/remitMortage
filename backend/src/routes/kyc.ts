import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import logger from "../utils/logger.js";
import { loadConfig } from "../config.js";
import { authMiddleware, AuthenticatedRequest } from "../middleware/auth.js";
import { encryptKycUpload, KycUploadRequest } from "../middleware/kycEncryption.js";
import { storeEncryptedDocument, getEncryptedDocument } from "../services/kycStorage.js";
import { decryptBuffer } from "../services/kmsEncryption.js";
import { issueKycAccessToken, verifyKycAccessToken } from "../services/kycAccessToken.js";
import { extractKycFields } from "../services/ocrService.js";
import {
  createOcrResult,
  getOcrResult,
  confirmOcrFields,
  getUnconfirmedFields,
} from "../services/kycOcrStore.js";

export const kycRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});
const uploadSingle = upload.single("document");

const ALLOWED_KYC_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png"];

/** Gates operator-only endpoints behind the shared admin API key. */
function requireOperatorKey(req: Request, res: Response, next: NextFunction) {
  const config = loadConfig();
  const key = req.headers["x-admin-api-key"];
  if (!key || key !== config.adminApiKey) {
    res.status(401).json({ error: "unauthorized", message: "Valid operator API key required" });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// OCR extraction middleware
//
// Runs on the raw plaintext buffer BEFORE encryptKycUpload zeros it.
// Stores the OcrResult on req so the final handler can persist it after
// the document ID is known.  Extraction errors are non-fatal — the upload
// succeeds regardless; the OcrResult records the failure.
// ---------------------------------------------------------------------------
interface OcrRequest extends Request {
  _ocrMimeType?: string;
  _ocrBuffer?: Buffer;
}

function captureBufferForOcr(
  req: OcrRequest,
  _res: Response,
  next: NextFunction
): void {
  if (req.file?.buffer?.length) {
    // Take a copy before encryptKycUpload zeros req.file.buffer
    req._ocrBuffer = Buffer.from(req.file.buffer);
    req._ocrMimeType = req.file.mimetype;
  }
  next();
}

// ---------------------------------------------------------------------------
// POST /api/kyc/:address/upload
//
// Changes from the original route:
//   1. captureBufferForOcr runs between multer and encryptKycUpload to save
//      the plaintext bytes for OCR.
//   2. After storeEncryptedDocument succeeds, OCR extraction runs on the saved
//      buffer and the result is persisted to KycOcrResult.
//   3. The 201 response body is extended with an `ocr` object so the
//      frontend can pre-fill onboarding fields immediately.
//
// All original upload/auth/encryption behaviour is preserved unchanged.
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/kyc/{address}/upload:
 *   post:
 *     summary: Upload a borrower KYC document
 *     description: >-
 *       Accepts a multipart KYC document (passport, payroll stub, credit
 *       rating, etc.), envelope-encrypts it in-memory before it ever touches
 *       storage, and persists only the ciphertext to the private document
 *       bucket. Runs OCR on the plaintext buffer before encryption and returns
 *       extracted name/idNumber/address fields (marked unconfirmed) so the
 *       frontend can pre-fill the onboarding form.
 *     tags:
 *       - KYC
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               document: { type: string, format: binary }
 *     responses:
 *       201:
 *         description: Document encrypted and stored; OCR result included.
 *       400:
 *         description: Missing file, oversized file, or unsupported file type.
 *       403:
 *         description: Authenticated wallet does not match the path address.
 */
kycRouter.post(
  "/:address/upload",
  authMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    uploadSingle(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(400).json({
            error: "file_too_large",
            message: "KYC document exceeds the 10MB limit.",
          });
          return;
        }
        res.status(400).json({ error: "upload_failed", message: err.message });
        return;
      } else if (err) {
        res.status(500).json({ error: "upload_failed", message: err.message });
        return;
      }
      next();
    });
  },
  // Capture raw buffer for OCR before encryption zeros it
  captureBufferForOcr,
  encryptKycUpload,
  async (req: AuthenticatedRequest & KycUploadRequest & OcrRequest, res: Response) => {
    try {
      const address = String(req.params.address);
      if (req.user?.walletAddress !== address) {
        res.status(403).json({
          error: "forbidden",
          message: "You may only upload documents for your own address.",
        });
        return;
      }
      if (!req.file || !req.kycEnvelope) {
        res.status(400).json({
          error: "missing_file",
          message: "No document was uploaded. Please attach a file to the request.",
        });
        return;
      }
      if (!ALLOWED_KYC_MIME_TYPES.includes(req.file.mimetype)) {
        res.status(400).json({
          error: "invalid_file_type",
          message: "Only PDF, JPEG, and PNG documents are accepted.",
        });
        return;
      }

      // Store the encrypted document (existing behaviour — unchanged)
      const record = await storeEncryptedDocument(
        address,
        req.file.originalname,
        req.file.mimetype,
        req.kycEnvelope
      );

      // Run OCR on the plaintext buffer captured before encryption
      const ocrBuffer = req._ocrBuffer ?? Buffer.alloc(0);
      const ocrMime = req._ocrMimeType ?? req.file.mimetype;
      const ocrResult = await extractKycFields(ocrBuffer, ocrMime);

      // Persist the OCR result (non-fatal — upload already succeeded)
      let ocrRecord: Awaited<ReturnType<typeof createOcrResult>> | null = null;
      try {
        ocrRecord = await createOcrResult(record.documentId, address, ocrResult);
      } catch (ocrStoreErr) {
        logger.warn("[KYC] Failed to persist OCR result", { ocrStoreErr, documentId: record.documentId });
      }

      // Build the OCR portion of the response so the frontend can pre-fill
      // onboarding fields.  Fields are always marked unconfirmed here —
      // the applicant must confirm them via POST /api/kyc/:documentId/confirm.
      const ocrResponse = ocrRecord
        ? {
            extractedName: ocrRecord.extractedName,
            nameConfirmed: false,
            extractedIdNumber: ocrRecord.extractedIdNumber,
            idNumberConfirmed: false,
            extractedAddress: ocrRecord.extractedAddress,
            addressConfirmed: false,
            ocrFailed: ocrRecord.ocrFailed,
          }
        : { ocrFailed: true };

      res.status(201).json({
        documentId: record.documentId,
        uploadedAt: record.uploadedAt,
        ocr: ocrResponse,
      });
    } catch (error) {
      logger.error("[KYC] Upload error", { error });
      res.status(500).json({
        error: "upload_failed",
        message: (error as Error).message || "Failed to store KYC document.",
      });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/kyc/:documentId/confirm
//
// The applicant explicitly confirms one or more OCR-extracted fields.
// Only fields set to true in the request body are updated.
//
// Request body (all optional, at least one required):
//   { confirmName?: true, confirmIdNumber?: true, confirmAddress?: true }
//
// Returns the updated OCR record so the frontend knows which fields are
// still pending confirmation.
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/kyc/{documentId}/confirm:
 *   post:
 *     summary: Confirm OCR-extracted KYC fields
 *     description: >-
 *       The authenticated applicant explicitly confirms one or more fields that
 *       were pre-filled by OCR.  All OCR-filled fields must be confirmed before
 *       the onboarding submission is accepted.
 *     tags:
 *       - KYC
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               confirmName:      { type: boolean }
 *               confirmIdNumber:  { type: boolean }
 *               confirmAddress:   { type: boolean }
 *     responses:
 *       200:
 *         description: Updated confirmation state.
 *       400:
 *         description: No confirmation fields supplied.
 *       403:
 *         description: Document does not belong to the authenticated wallet.
 *       404:
 *         description: OCR result not found for this document.
 */
kycRouter.post(
  "/:documentId/confirm",
  authMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    const documentId = String(req.params.documentId);
    const { confirmName, confirmIdNumber, confirmAddress } = req.body ?? {};

    if (!confirmName && !confirmIdNumber && !confirmAddress) {
      res.status(400).json({
        error: "missing_field",
        message:
          "At least one of confirmName, confirmIdNumber, or confirmAddress must be true.",
      });
      return;
    }

    const ocrRecord = await getOcrResult(documentId);
    if (!ocrRecord) {
      res.status(404).json({ error: "ocr_result_not_found" });
      return;
    }

    // Ensure the authenticated wallet matches the document owner
    if (req.user?.walletAddress !== ocrRecord.applicantAddress) {
      res.status(403).json({
        error: "forbidden",
        message: "You may only confirm documents for your own address.",
      });
      return;
    }

    const updated = await confirmOcrFields(documentId, {
      confirmName: confirmName === true,
      confirmIdNumber: confirmIdNumber === true,
      confirmAddress: confirmAddress === true,
    });

    const unconfirmed = getUnconfirmedFields(updated);

    res.json({
      documentId,
      extractedName: updated.extractedName,
      nameConfirmed: updated.nameConfirmed,
      extractedIdNumber: updated.extractedIdNumber,
      idNumberConfirmed: updated.idNumberConfirmed,
      extractedAddress: updated.extractedAddress,
      addressConfirmed: updated.addressConfirmed,
      ocrFailed: updated.ocrFailed,
      unconfirmedFields: unconfirmed,
      allConfirmed: unconfirmed.length === 0,
    });
  }
);

// ---------------------------------------------------------------------------
// POST /api/kyc/:documentId/submit
//
// Final onboarding submission gate.  Rejects the submission if any
// OCR-extracted field is still unconfirmed.  When OCR failed entirely
// (ocrFailed=true and no fields extracted) manual entry is assumed and the
// check is skipped — preserving the existing manual verification flow.
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/kyc/{documentId}/submit:
 *   post:
 *     summary: Submit KYC onboarding after confirming OCR-filled fields
 *     description: >-
 *       Validates that all OCR-extracted fields have been confirmed by the
 *       applicant.  Rejects the submission if any extracted field is still
 *       unconfirmed.  When OCR could not extract any field (ocrFailed=true)
 *       the check is skipped and the manual-entry path continues unchanged.
 *     tags:
 *       - KYC
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Submission accepted.
 *       400:
 *         description: Unconfirmed OCR fields — lists which fields need confirmation.
 *       403:
 *         description: Document does not belong to the authenticated wallet.
 *       404:
 *         description: Document not found.
 */
kycRouter.post(
  "/:documentId/submit",
  authMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    const documentId = String(req.params.documentId);

    const ocrRecord = await getOcrResult(documentId);

    // When there is no OCR record (document pre-dates OCR, or OCR store
    // errored) we fall through to allow manual-entry submissions unchanged.
    if (ocrRecord && !ocrRecord.ocrFailed) {
      // Verify the document belongs to the authenticated wallet
      if (req.user?.walletAddress !== ocrRecord.applicantAddress) {
        res.status(403).json({
          error: "forbidden",
          message: "You may only submit documents for your own address.",
        });
        return;
      }

      const unconfirmed = getUnconfirmedFields(ocrRecord);
      if (unconfirmed.length > 0) {
        res.status(400).json({
          error: "unconfirmed_ocr_fields",
          message:
            "All OCR-extracted fields must be confirmed before submission. " +
            `Please confirm: ${unconfirmed.join(", ")}.`,
          unconfirmedFields: unconfirmed,
        });
        return;
      }
    }

    // All fields confirmed (or OCR was not available) — submission accepted.
    res.json({ submitted: true, documentId });
  }
);

// ---------------------------------------------------------------------------
// GET /api/kyc/:documentId/ocr  (convenience read endpoint)
//
// Returns the current OCR result and confirmation state for a document.
// Useful for the frontend to check pre-fill state after an upload.
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/kyc/{documentId}/ocr:
 *   get:
 *     summary: Get OCR extraction result for a KYC document
 *     tags:
 *       - KYC
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: OCR result and confirmation state.
 *       403:
 *         description: Document does not belong to the authenticated wallet.
 *       404:
 *         description: No OCR result found for this document.
 */
kycRouter.get(
  "/:documentId/ocr",
  authMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    const documentId = String(req.params.documentId);
    const ocrRecord = await getOcrResult(documentId);

    if (!ocrRecord) {
      res.status(404).json({ error: "ocr_result_not_found" });
      return;
    }

    if (req.user?.walletAddress !== ocrRecord.applicantAddress) {
      res.status(403).json({
        error: "forbidden",
        message: "You may only view OCR results for your own documents.",
      });
      return;
    }

    const unconfirmed = getUnconfirmedFields(ocrRecord);

    res.json({
      documentId,
      extractedName: ocrRecord.extractedName,
      nameConfirmed: ocrRecord.nameConfirmed,
      extractedIdNumber: ocrRecord.extractedIdNumber,
      idNumberConfirmed: ocrRecord.idNumberConfirmed,
      extractedAddress: ocrRecord.extractedAddress,
      addressConfirmed: ocrRecord.addressConfirmed,
      ocrFailed: ocrRecord.ocrFailed,
      ocrError: ocrRecord.ocrError,
      unconfirmedFields: unconfirmed,
      allConfirmed: unconfirmed.length === 0,
    });
  }
);

// ---------------------------------------------------------------------------
// POST /api/kyc/access-token  (unchanged)
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/kyc/access-token:
 *   post:
 *     summary: Issue a temporary decryption token for a KYC document
 *     description: Operator-only. Issues a short-lived, single-document IAM-style token.
 *     tags:
 *       - KYC
 *     responses:
 *       200:
 *         description: Temporary access token issued.
 *       401:
 *         description: Missing or invalid operator API key.
 *       404:
 *         description: Document not found.
 */
kycRouter.post("/access-token", requireOperatorKey, async (req: Request, res: Response) => {
  const { documentId, operatorId } = req.body ?? {};
  if (!documentId || !operatorId) {
    res.status(400).json({
      error: "missing_field",
      message: "documentId and operatorId are required",
    });
    return;
  }

  const record = await getEncryptedDocument(String(documentId));
  if (!record) {
    res.status(404).json({ error: "document_not_found" });
    return;
  }

  const { token, expiresIn } = issueKycAccessToken(String(operatorId), String(documentId));
  res.json({ token, expiresIn });
});

// ---------------------------------------------------------------------------
// GET /api/kyc/:documentId/decrypt  (unchanged)
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/kyc/{documentId}/decrypt:
 *   get:
 *     summary: Decrypt a stored KYC document
 *     description: >-
 *       Operator-only. Requires a temporary access token (issued via
 *       POST /api/kyc/access-token) scoped to this exact document.
 *     tags:
 *       - KYC
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Decrypted document streamed back.
 *       401:
 *         description: Missing operator key or missing/invalid/expired access token.
 *       404:
 *         description: Document not found.
 */
kycRouter.get("/:documentId/decrypt", requireOperatorKey, async (req: Request, res: Response) => {
  const documentId = String(req.params.documentId);
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

  if (!token) {
    res.status(401).json({ error: "unauthorized", message: "Temporary access token required" });
    return;
  }

  try {
    verifyKycAccessToken(token, documentId);
  } catch {
    res.status(401).json({ error: "unauthorized", message: "Invalid or expired access token" });
    return;
  }

  try {
    const record = await getEncryptedDocument(documentId);
    if (!record) {
      res.status(404).json({ error: "document_not_found" });
      return;
    }

    const plaintext = decryptBuffer(record.envelope);
    res.setHeader("Content-Type", record.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${record.originalName}"`);
    res.send(plaintext);
  } catch (error) {
    logger.error("[KYC] Decrypt error", { error, documentId });
    res.status(500).json({
      error: "decrypt_failed",
      message: (error as Error).message || "Failed to decrypt KYC document.",
    });
  }
});
