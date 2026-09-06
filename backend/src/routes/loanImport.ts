import { Router } from "express";
import multer from "multer";
import logger from "../utils/logger.js";
import { parseCsv, stageCsvImport } from "../services/csvImportService.js";

export const loanImportRouter = Router();

// Accept CSV file uploads up to 5 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype === "text/csv" ||
      file.originalname.endsWith(".csv")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV files are accepted"));
    }
  },
});

/**
 * POST /api/loan/import
 *
 * Bulk import loan records from a CSV file.
 *
 * Query params:
 *   - dryRun=true  — validate rows and return a preview without committing
 *
 * Body: multipart/form-data with a `file` field containing the CSV.
 *
 * Response:
 *   - totalRows: number of data rows parsed
 *   - validRows: rows that passed validation
 *   - errorRows: rows with validation errors
 *   - errors: per-row error details [{ rowNumber, field?, message }]
 *   - stagedIds: (dry-run only) placeholder IDs for each valid row
 */
loanImportRouter.post("/", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "missing_file",
        message: "A CSV file is required in the 'file' field",
      });
    }

    const dryRun = req.query.dryRun === "true";
    const content = req.file.buffer.toString("utf-8");
    const rows = parseCsv(content);

    if (rows.length === 0) {
      return res.status(400).json({
        error: "empty_csv",
        message: "The CSV file contains no data rows",
      });
    }

    const result = await stageCsvImport(rows, dryRun);

    return res.status(200).json({
      dryRun,
      ...result,
    });
  } catch (err: any) {
    logger.error("CSV import error", { error: err.message });
    return res.status(500).json({
      error: "import_failed",
      message: err.message,
    });
  }
});
