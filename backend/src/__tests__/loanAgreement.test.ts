// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  createInMemoryLoanAgreementStore,
  generateLoanAgreement,
  hashAgreementTerms,
  renderAgreementLines,
  type LoanAgreementTerms,
} from "../services/loanAgreement";

const TERMS: LoanAgreementTerms = {
  loanId: "loan-123",
  loanVersion: 3,
  borrowerAddress: "GBORROWER111111111111111111111111111111111111111111111",
  principal: "70000",
  currency: "USDC",
  interestRateBps: 850,
  termMonths: 24,
  loanType: "Purchase",
  rateSheetVersionId: "rs-7",
};

describe("renderAgreementLines", () => {
  it("shows every key term from the loan record", () => {
    const text = renderAgreementLines(TERMS).join("\n");
    expect(text).toContain("Loan ID: loan-123");
    expect(text).toContain(`Borrower: ${TERMS.borrowerAddress}`);
    expect(text).toContain("Principal: 70000 USDC");
    expect(text).toContain("Annual interest rate: 8.50%");
    expect(text).toContain("Term: 24 months");
    expect(text).toContain("Loan type: Purchase");
    expect(text).toContain("Rate sheet version: rs-7");
    expect(text).toContain("loan record version 3");
    expect(text).not.toMatch(/\{\{/);
  });

  it("falls back to the repayment schedule when the record has no term", () => {
    const text = renderAgreementLines({ ...TERMS, termMonths: undefined }).join("\n");
    expect(text).toContain("Term: As set out in the repayment schedule");
  });
});

describe("hashAgreementTerms", () => {
  it("is deterministic regardless of key order", () => {
    const reordered = Object.fromEntries(Object.entries(TERMS).reverse()) as unknown as LoanAgreementTerms;
    expect(hashAgreementTerms(reordered, "2026-01")).toBe(hashAgreementTerms(TERMS, "2026-01"));
  });

  it("changes when a term or the template version changes", () => {
    const base = hashAgreementTerms(TERMS, "2026-01");
    expect(hashAgreementTerms({ ...TERMS, interestRateBps: 900 }, "2026-01")).not.toBe(base);
    expect(hashAgreementTerms(TERMS, "2027-01")).not.toBe(base);
  });
});

describe("generateLoanAgreement", () => {
  const now = new Date("2026-11-20T10:00:00Z");

  it("renders a PDF that embeds the document hash and loan version", async () => {
    const store = createInMemoryLoanAgreementStore();
    const { agreement, created } = await generateLoanAgreement(TERMS, { store, now });

    expect(created).toBe(true);
    expect(agreement.agreementVersion).toBe(1);
    expect(agreement.loanVersion).toBe(3);
    expect(agreement.documentHash).toMatch(/^[a-f0-9]{64}$/);
    const raw = agreement.pdf.toString("latin1");
    expect(raw.startsWith("%PDF-")).toBe(true);
    expect(raw).toContain(`sha256:${agreement.documentHash}`);
    expect(raw).toContain("Loan record version 3");
  });

  it("returns the stored agreement when terms are unchanged", async () => {
    const store = createInMemoryLoanAgreementStore();
    const first = await generateLoanAgreement(TERMS, { store, now });
    const again = await generateLoanAgreement(TERMS, { store, now });

    expect(again.created).toBe(false);
    expect(again.agreement.documentHash).toBe(first.agreement.documentHash);
    expect(await store.list(TERMS.loanId)).toHaveLength(1);
  });

  it("creates a new version with a different hash after a terms change", async () => {
    const store = createInMemoryLoanAgreementStore();
    const first = await generateLoanAgreement(TERMS, { store, now });
    const changed = await generateLoanAgreement(
      { ...TERMS, loanVersion: 4, interestRateBps: 900 },
      { store, now }
    );

    expect(changed.created).toBe(true);
    expect(changed.agreement.agreementVersion).toBe(2);
    expect(changed.agreement.loanVersion).toBe(4);
    expect(changed.agreement.documentHash).not.toBe(first.agreement.documentHash);
    const versions = await store.list(TERMS.loanId);
    expect(versions.map((a) => a.agreementVersion)).toEqual([1, 2]);
  });

  it("rejects an unknown template version", async () => {
    await expect(
      generateLoanAgreement(TERMS, { store: createInMemoryLoanAgreementStore(), templateVersion: "1999-01" })
    ).rejects.toThrow(/Unknown agreement template/);
  });
});
