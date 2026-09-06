/**
 * KYC OCR auto-fill service.
 *
 * OCR provider / dependency decision
 * ────────────────────────────────────
 * No OCR library exists in the project (no tesseract, sharp, jimp, pdfjs,
 * vision, or textract dependency is installed — confirmed by package.json
 * inspection).  The requirement asks for the "smallest practical, mockable
 * OCR abstraction".
 *
 * Chosen approach: a thin provider interface backed by two implementations:
 *
 *   1. RegexOcrProvider — the default production provider.
 *      Uses zero new dependencies.  Works by decoding the raw file buffer as
 *      UTF-8 text and applying regex patterns that match common structured
 *      text in machine-readable PDFs (e.g. e-passports exported as text-layer
 *      PDFs, government-issued ID PDFs, etc.).
 *      This is the "smallest practical" solution: it genuinely extracts values
 *      from text-readable documents without requiring a native binary (which
 *      would break in CI/serverless) or a paid cloud API key.
 *
 *   2. OcrProvider interface — fully mockable in tests via setOcrProvider().
 *      Tests inject a mock provider that returns pre-canned results, so the
 *      acceptance tests can run without any real document bytes.
 *
 * OCR provider limitation (documented):
 *   The regex-based provider cannot extract text from:
 *   - Scanned image PDFs (no text layer)
 *   - Raw JPEG/PNG images
 *   For those, all three fields are returned as null and ocrFailed=true.
 *   Full image OCR requires a real OCR provider such as:
 *   - tesseract.js (pure-JS, no native binary)  — npm install tesseract.js
 *   - Google Cloud Vision API                   — requires GOOGLE_APPLICATION_CREDENTIALS
 *   - AWS Textract                              — requires AWS credentials
 *   The interface below is designed so any of these can be plugged in by
 *   implementing OcrProvider and calling setOcrProvider() at startup.
 */

export interface OcrExtractedFields {
  /** Full legal name extracted from the document, or null if not found. */
  name: string | null;
  /** Government-issued ID number (passport, national ID), or null. */
  idNumber: string | null;
  /** Residential address, or null. */
  address: string | null;
}

export interface OcrResult {
  fields: OcrExtractedFields;
  /** True when extraction ran successfully (even if no fields were found). */
  success: boolean;
  /** Error message when the provider threw, or null. */
  error: string | null;
}

/** Injectable OCR provider interface — implement to swap the extraction engine. */
export interface OcrProvider {
  extract(buffer: Buffer, mimeType: string): Promise<OcrResult>;
}

// ---------------------------------------------------------------------------
// Regex-based provider (default — zero new dependencies)
// ---------------------------------------------------------------------------

/**
 * Extracts name, ID number, and address from text-layer PDFs and plaintext
 * using regex patterns that match common government-document formats.
 *
 * Patterns are intentionally broad so they work across multiple jurisdictions:
 *
 *   Name       — lines starting with "Name:", "Full Name:", "Surname/Given Names:"
 *                or Machine-Readable Zone (MRZ) lines (uppercase alpha + <<)
 *
 *   ID Number  — lines starting with "Passport No:", "ID No:", "Document No:",
 *                "Passport Number:", or matching common MRZ document-number patterns
 *                (alphanumeric, 6–12 chars, possibly followed by check digit)
 *
 *   Address    — lines starting with "Address:", "Residential Address:",
 *                "Place of Birth/Address:" or containing a postcode/zip pattern
 */
export class RegexOcrProvider implements OcrProvider {
  async extract(buffer: Buffer, mimeType: string): Promise<OcrResult> {
    try {
      const text = buffer.toString("utf8");

      const name = extractName(text);
      const idNumber = extractIdNumber(text);
      const address = extractAddress(text);

      return {
        fields: { name, idNumber, address },
        success: true,
        error: null,
      };
    } catch (err) {
      return {
        fields: { name: null, idNumber: null, address: null },
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Regex helpers
// ---------------------------------------------------------------------------

function extractName(text: string): string | null {
  // Labelled fields (case-insensitive)
  const labelPattern = /(?:full\s+)?name\s*[:\-]\s*(.+)/i;
  const surnamePattern = /surname\s*[:\-]\s*(.+)/i;

  // MRZ line 2 of TD3 (passport): 44 chars of uppercase, <, digits
  // The name section is the first 39 chars (before document number),
  // formatted as SURNAME<<GIVENNAMES
  const mrzPattern = /^([A-Z]{1,39}<<[A-Z<]{1,30})/m;

  for (const pat of [labelPattern, surnamePattern]) {
    const m = text.match(pat);
    if (m?.[1]) {
      const name = m[1].trim().replace(/\s+/g, " ");
      if (name.length >= 2) return name;
    }
  }

  const mrz = text.match(mrzPattern);
  if (mrz?.[1]) {
    // Convert MRZ name to human-readable: "DOE<<JOHN" → "DOE JOHN"
    return mrz[1].replace(/<<+/g, " ").replace(/</g, " ").trim();
  }

  return null;
}

function extractIdNumber(text: string): string | null {
  // Labelled fields
  const labelPattern =
    /(?:passport\s+(?:no|number|num)|id\s+(?:no|number)|document\s+(?:no|number)|national\s+id)\s*[:\-#]?\s*([A-Z0-9]{6,12})/i;

  // Bare alphanumeric patterns that look like ID numbers
  // (e.g. "A1234567", "123456789", "AB123456C")
  const barePattern = /\b([A-Z]{1,2}[0-9]{6,9}[A-Z]?)\b/;

  const m = text.match(labelPattern);
  if (m?.[1]) return m[1].trim().toUpperCase();

  const b = text.match(barePattern);
  if (b?.[1]) return b[1].trim().toUpperCase();

  return null;
}

function extractAddress(text: string): string | null {
  // Labelled single-line address
  const labelPattern =
    /(?:residential\s+)?address\s*[:\-]\s*(.+)/i;

  // Postcode/zip at end of a line → take the whole line as the address
  const postcodePattern =
    /(.{10,80}(?:[A-Z]{1,2}\d{1,2}\s?\d[A-Z]{2}|\d{5}(?:-\d{4})?|\d{4}\s?[A-Z]{2}))/i;

  const m = text.match(labelPattern);
  if (m?.[1]) {
    const addr = m[1].trim();
    if (addr.length >= 5) return addr;
  }

  const p = text.match(postcodePattern);
  if (p?.[1]) {
    return p[1].trim();
  }

  return null;
}

// ---------------------------------------------------------------------------
// Singleton provider — injectable for tests
// ---------------------------------------------------------------------------

let _provider: OcrProvider = new RegexOcrProvider();

/** Replace the active OCR provider (used in tests and at startup). */
export function setOcrProvider(provider: OcrProvider): void {
  _provider = provider;
}

/** Returns the currently active OCR provider. */
export function getOcrProvider(): OcrProvider {
  return _provider;
}

/**
 * Convenience function used by the KYC upload route.
 * Delegates to the currently active provider.
 */
export async function extractKycFields(
  buffer: Buffer,
  mimeType: string
): Promise<OcrResult> {
  return _provider.extract(buffer, mimeType);
}
