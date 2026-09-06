import { prisma } from "./db.js";
import logger from "../utils/logger.js";

/**
 * CSV schema for bulk loan import.
 *
 * Required columns:
 *   - borrowerAddress: Stellar G-address (Ed25519 public key)
 *   - amount: positive number (loan principal in USDC)
 *
 * Optional columns:
 *   - fullName: borrower's full legal name
 *   - taxId: government-issued tax identifier
 *   - interestRateBps: annual interest rate in basis points (default 800)
 */
export interface CsvLoanRow {
  borrowerAddress: string;
  amount: string;
  fullName?: string;
  taxId?: string;
  interestRateBps?: number;
  /** 1-indexed row number in the original CSV (for error reporting). */
  rowNumber: number;
}

export interface ImportError {
  rowNumber: number;
  field?: string;
  message: string;
}

export interface ImportResult {
  totalRows: number;
  validRows: number;
  errorRows: number;
  errors: ImportError[];
  /** Only populated in dry-run mode — the staged application IDs. */
  stagedIds?: string[];
}

/**
 * Parse a raw CSV string into structured loan rows.
 * Expects a header row followed by data rows.
 */
export function parseCsv(content: string): CsvLoanRow[] {
  const lines = content.trim().split("\n");
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const rows: CsvLoanRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map((v) => v.trim());
    if (values.length === 0 || (values.length === 1 && values[0] === "")) continue;

    const row: Record<string, string> = {};
    header.forEach((h, idx) => {
      row[h] = values[idx] || "";
    });

    rows.push({
      borrowerAddress: row["borroweraddress"] || row["borrower_address"] || "",
      amount: row["amount"] || "",
      fullName: row["fullname"] || row["full_name"] || undefined,
      taxId: row["taxid"] || row["tax_id"] || undefined,
      interestRateBps: row["interestratebps"] || row["interest_rate_bps"]
        ? parseInt(row["interestratebps"] || row["interest_rate_bps"] || "0", 10)
        : undefined,
      rowNumber: i + 1,
    });
  }

  return rows;
}

/**
 * Validate a single CSV row without touching the database.
 */
function validateRow(row: CsvLoanRow): ImportError[] {
  const errors: ImportError[] = [];

  if (!row.borrowerAddress) {
    errors.push({ rowNumber: row.rowNumber, field: "borrowerAddress", message: "borrowerAddress is required" });
  } else if (!row.borrowerAddress.startsWith("G") || row.borrowerAddress.length !== 56) {
    errors.push({ rowNumber: row.rowNumber, field: "borrowerAddress", message: "Invalid Stellar G-address" });
  }

  if (!row.amount) {
    errors.push({ rowNumber: row.rowNumber, field: "amount", message: "amount is required" });
  } else {
    const num = parseFloat(row.amount);
    if (isNaN(num) || num <= 0) {
      errors.push({ rowNumber: row.rowNumber, field: "amount", message: "amount must be a positive number" });
    }
  }

  if (row.interestRateBps !== undefined) {
    if (isNaN(row.interestRateBps) || row.interestRateBps < 200 || row.interestRateBps > 1800) {
      errors.push({
        rowNumber: row.rowNumber,
        field: "interestRateBps",
        message: "interestRateBps must be between 200 and 1800",
      });
    }
  }

  return errors;
}

/**
 * Stage CSV rows as Draft loan applications.
 * Returns errors per row but does NOT throw — valid rows are still imported.
 */
export async function stageCsvImport(rows: CsvLoanRow[], dryRun: boolean): Promise<ImportResult> {
  const allErrors: ImportError[] = [];
  const stagedIds: string[] = [];

  for (const row of rows) {
    const validationErrors = validateRow(row);
    if (validationErrors.length > 0) {
      allErrors.push(...validationErrors);
      continue;
    }

    try {
      // Find or create applicant
      const applicant = await prisma.applicant.upsert({
        where: { stellarAddress: row.borrowerAddress },
        update: { deletedAt: null },
        create: { stellarAddress: row.borrowerAddress },
      });

      if (!dryRun) {
        // Create the loan application as a Draft for legacy migration
        const loan = await prisma.loanApplication.create({
          data: {
            applicantId: applicant.id,
            principal: parseFloat(row.amount),
            interestRateBps: row.interestRateBps ?? 800,
            status: "Draft",
          },
        });
        stagedIds.push(loan.id);

        // Write audit log for traceability
        await prisma.auditLog.create({
          data: {
            action: "csv_import",
            actorAddress: "system",
            metadata: {
              loanId: loan.id,
              borrowerAddress: row.borrowerAddress,
              amount: row.amount,
              rowNumber: row.rowNumber,
              source: "bulk_csv_import",
            },
          },
        });
      } else {
        // Dry-run: just validate, don't commit
        stagedIds.push(`dry-run-row-${row.rowNumber}`);
      }
    } catch (err: any) {
      allErrors.push({
        rowNumber: row.rowNumber,
        message: `Database error: ${err.message}`,
      });
    }
  }

  const validRows = rows.length - allErrors.filter((e) => !e.message.includes("Database error")).length;

  logger.info("CSV import processed", {
    totalRows: rows.length,
    validRows,
    errorRows: allErrors.length,
    dryRun,
  });

  return {
    totalRows: rows.length,
    validRows,
    errorRows: allErrors.length,
    errors: allErrors,
    stagedIds: dryRun ? stagedIds : undefined,
  };
}
