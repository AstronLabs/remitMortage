// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Loan agreement generation (issue #921).
 *
 * Agreements are rendered from a versioned template with the terms on the
 * loan record, so the document can never drift from what was approved. Each
 * agreement embeds a SHA-256 hash of its terms and the loan record version
 * it was generated from; regenerating after a terms change yields a new
 * agreement version with a different hash, while regenerating unchanged
 * terms returns the existing agreement.
 *
 * PDFs are produced with pdfkit, which the backend already depends on.
 */

import crypto from "crypto";
import PDFDocument from "pdfkit";

export interface LoanAgreementTerms {
  loanId: string;
  /** `LoanApplication.version` the terms were read from. */
  loanVersion: number;
  borrowerAddress: string;
  principal: string;
  currency: string;
  interestRateBps: number;
  /** Repayment term; omitted when the loan record does not carry one. */
  termMonths?: number;
  loanType?: string;
  rateSheetVersionId?: string;
}

export interface LoanAgreementTemplate {
  version: string;
  title: string;
  /** Clause text with `{{placeholder}}` tokens, one paragraph each. */
  clauses: string[];
}

export const LOAN_AGREEMENT_TEMPLATES: Record<string, LoanAgreementTemplate> = {
  "2026-01": {
    version: "2026-01",
    title: "Remittance-Backed Mortgage Loan Agreement",
    clauses: [
      "Loan ID: {{loanId}}",
      "Borrower: {{borrowerAddress}}",
      "Principal: {{principal}} {{currency}}",
      "Annual interest rate: {{interestRate}}",
      "Term: {{term}}",
      "Loan type: {{loanType}}",
      "Rate sheet version: {{rateSheetVersionId}}",
      "The Borrower agrees to repay the Principal with interest at the rate above in equal monthly instalments over the Term.",
      "This agreement reflects loan record version {{loanVersion}}. Any change to these terms requires a new agreement.",
    ],
  },
};

export const CURRENT_AGREEMENT_TEMPLATE_VERSION = "2026-01";

export function formatInterestRate(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/** Fills a template with the loan's terms; returns the agreement body lines. */
export function renderAgreementLines(
  terms: LoanAgreementTerms,
  template: LoanAgreementTemplate = LOAN_AGREEMENT_TEMPLATES[CURRENT_AGREEMENT_TEMPLATE_VERSION]
): string[] {
  const values: Record<string, string> = {
    loanId: terms.loanId,
    borrowerAddress: terms.borrowerAddress,
    principal: terms.principal,
    currency: terms.currency,
    interestRate: formatInterestRate(terms.interestRateBps),
    term: terms.termMonths ? `${terms.termMonths} months` : "As set out in the repayment schedule",
    loanType: terms.loanType ?? "Standard",
    rateSheetVersionId: terms.rateSheetVersionId ?? "n/a",
    loanVersion: String(terms.loanVersion),
  };
  return template.clauses.map((clause) =>
    clause.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      if (!(key in values)) throw new Error(`Unknown agreement placeholder: ${key}`);
      return values[key];
    })
  );
}

/**
 * Deterministic hash over the template version and every term (keys sorted),
 * so the same terms always give the same hash and any change gives a new one.
 */
export function hashAgreementTerms(terms: LoanAgreementTerms, templateVersion: string): string {
  const sorted = Object.fromEntries(
    Object.entries(terms)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
  );
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ templateVersion, terms: sorted }), "utf8")
    .digest("hex");
}

/** Renders the agreement PDF. Hash and loan version are printed and stored in the PDF metadata. */
export function renderAgreementPdf(params: {
  template: LoanAgreementTemplate;
  lines: string[];
  documentHash: string;
  loanVersion: number;
  agreementVersion: number;
  generatedAt: Date;
}): Promise<Buffer> {
  const { template, lines, documentHash, loanVersion, agreementVersion, generatedAt } = params;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 50,
      info: {
        Title: template.title,
        Subject: `Loan record version ${loanVersion}; agreement version ${agreementVersion}`,
        Keywords: `sha256:${documentHash}`,
        CreationDate: generatedAt,
      },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(16).text(template.title, { align: "center" });
    doc.moveDown(0.5);
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#64748b")
      .text(`Template ${template.version} | Agreement version ${agreementVersion} | Generated ${generatedAt.toISOString()}`, {
        align: "center",
      });
    doc.moveDown(1.5).fillColor("#111827").fontSize(11);
    for (const line of lines) doc.text(line).moveDown(0.4);

    doc.moveDown(2).fontSize(8).fillColor("#374151");
    doc.text(`Loan record version: ${loanVersion}`);
    doc.font("Courier").text(`Document hash (SHA-256): ${documentHash}`);
    doc.end();
  });
}

export interface StoredLoanAgreement {
  loanId: string;
  borrowerAddress: string;
  agreementVersion: number;
  templateVersion: string;
  loanVersion: number;
  documentHash: string;
  generatedAt: Date;
  pdf: Buffer;
}

/** Persistence for generated agreements. The in-memory default is for tests and single-node dev. */
export interface LoanAgreementStore {
  list(loanId: string): Promise<StoredLoanAgreement[]>;
  save(agreement: StoredLoanAgreement): Promise<void>;
}

export function createInMemoryLoanAgreementStore(): LoanAgreementStore {
  const byLoan = new Map<string, StoredLoanAgreement[]>();
  return {
    async list(loanId) {
      return [...(byLoan.get(loanId) ?? [])];
    },
    async save(agreement) {
      byLoan.set(agreement.loanId, [...(byLoan.get(agreement.loanId) ?? []), agreement]);
    },
  };
}

export const defaultLoanAgreementStore = createInMemoryLoanAgreementStore();

/**
 * Generates (or returns the existing) agreement for the given terms. A new
 * agreement version is created only when the terms hash differs from the
 * latest stored agreement for the loan.
 */
export async function generateLoanAgreement(
  terms: LoanAgreementTerms,
  options: {
    store?: LoanAgreementStore;
    templateVersion?: string;
    now?: Date;
  } = {}
): Promise<{ agreement: StoredLoanAgreement; created: boolean }> {
  const store = options.store ?? defaultLoanAgreementStore;
  const templateVersion = options.templateVersion ?? CURRENT_AGREEMENT_TEMPLATE_VERSION;
  const template = LOAN_AGREEMENT_TEMPLATES[templateVersion];
  if (!template) throw new Error(`Unknown agreement template version: ${templateVersion}`);

  const documentHash = hashAgreementTerms(terms, templateVersion);
  const existing = await store.list(terms.loanId);
  const latest = existing[existing.length - 1];
  if (latest && latest.documentHash === documentHash) {
    return { agreement: latest, created: false };
  }

  const agreementVersion = (latest?.agreementVersion ?? 0) + 1;
  const generatedAt = options.now ?? new Date();
  const pdf = await renderAgreementPdf({
    template,
    lines: renderAgreementLines(terms, template),
    documentHash,
    loanVersion: terms.loanVersion,
    agreementVersion,
    generatedAt,
  });

  const agreement: StoredLoanAgreement = {
    loanId: terms.loanId,
    borrowerAddress: terms.borrowerAddress,
    agreementVersion,
    templateVersion,
    loanVersion: terms.loanVersion,
    documentHash,
    generatedAt,
    pdf,
  };
  await store.save(agreement);
  return { agreement, created: true };
}
