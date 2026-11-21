// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

const logAuditMock = jest.fn();
jest.mock("../services/audit.js", () => ({
  logAudit: (...args: unknown[]) => logAuditMock(...args),
}));

import {
  METRO2_ACCOUNT_STATUS,
  METRO2_RECORD_LENGTH,
  Metro2ValidationError,
  buildMetro2File,
  createInMemoryMetro2FileStore,
  furnishMetro2File,
  validateMetro2File,
  type Metro2Account,
} from "../services/metro2Export";

const NOW = new Date("2026-11-01T08:30:00Z");
const FURNISHER = { identificationNumber: "RMTEST0001", reporterName: "RemitMortgage", cycleIdentifier: "01" };

function account(overrides: Partial<Metro2Account>): Metro2Account {
  return {
    loanId: "loan-current",
    borrowerId: "borrower-1",
    surname: "Okafor",
    firstName: "Ada",
    reportingConsent: true,
    openedAt: new Date("2025-01-15T00:00:00Z"),
    originalAmount: 70000,
    termMonths: 24,
    scheduledMonthlyPayment: 3200,
    lastPaymentAmount: 3200,
    lastPaymentAt: new Date("2026-10-15T00:00:00Z"),
    currentBalance: 40000,
    amountPastDue: 0,
    daysPastDue: 0,
    ...overrides,
  };
}

const FIXTURES: Metro2Account[] = [
  account({ loanId: "loan-current" }),
  account({
    loanId: "loan-late",
    daysPastDue: 45,
    amountPastDue: 3200,
    firstDelinquencyAt: new Date("2026-09-15T00:00:00Z"),
  }),
  account({
    loanId: "loan-paid-off",
    currentBalance: 0,
    closedAt: new Date("2026-10-15T00:00:00Z"),
  }),
  account({ loanId: "loan-disputed", disputed: true, flaggedForCorrection: true }),
  account({ loanId: "loan-disputed-open", disputed: true }),
  account({ loanId: "loan-no-consent", reportingConsent: false }),
];

function baseFor(file: ReturnType<typeof buildMetro2File>, loanId: string): string {
  const record = file.records.find((r) => r.slice(42, 72).trim() === loanId);
  if (!record) throw new Error(`no record for ${loanId}`);
  return record;
}

describe("buildMetro2File", () => {
  const file = buildMetro2File(FIXTURES, FURNISHER, NOW);

  it("produces a file that passes validation with fixed-width records", () => {
    expect(validateMetro2File(file.content)).toEqual([]);
    for (const record of file.records) expect(record).toHaveLength(METRO2_RECORD_LENGTH);
    expect(file.records[0].slice(4, 10)).toBe("HEADER");
    expect(file.records[file.records.length - 1].slice(4, 11)).toBe("TRAILER");
  });

  it("includes only consenting borrowers and skips disputes flagged for correction", () => {
    expect(file.includedLoanIds).toEqual([
      "loan-current",
      "loan-late",
      "loan-paid-off",
      "loan-disputed-open",
    ]);
    expect(file.excluded).toEqual([
      { loanId: "loan-disputed", reason: "dispute_flagged_for_correction" },
      { loanId: "loan-no-consent", reason: "no_consent" },
    ]);
    expect(file.recordCount).toBe(4);
    expect(file.content).not.toContain("loan-no-consent");
    expect(file.content).not.toContain("loan-disputed ");
  });

  it("maps current, late and paid-off accounts to the right status codes", () => {
    expect(baseFor(file, "loan-current").slice(123, 125)).toBe(METRO2_ACCOUNT_STATUS.CURRENT);
    expect(baseFor(file, "loan-late").slice(123, 125)).toBe(METRO2_ACCOUNT_STATUS.LATE_30);
    expect(baseFor(file, "loan-late").slice(163, 172)).toBe("000003200");
    expect(baseFor(file, "loan-late").slice(189, 197)).toBe("09152026");
    const paid = baseFor(file, "loan-paid-off");
    expect(paid.slice(123, 125)).toBe(METRO2_ACCOUNT_STATUS.PAID_OFF);
    expect(paid.slice(154, 163)).toBe("000000000");
  });

  it("reports an open dispute with the XB compliance condition code", () => {
    expect(baseFor(file, "loan-disputed-open").slice(152, 154)).toBe("XB");
    expect(baseFor(file, "loan-current").slice(152, 154)).toBe("  ");
  });

  it("writes the base record count into the trailer", () => {
    const trailer = file.records[file.records.length - 1];
    expect(Number(trailer.slice(11, 20))).toBe(4);
  });
});

describe("validateMetro2File", () => {
  it("rejects a file whose trailer count does not match", () => {
    const file = buildMetro2File(FIXTURES, FURNISHER, NOW);
    const tampered = file.records.filter((r) => !r.includes("loan-late")).join("\n");
    expect(validateMetro2File(tampered)).toContain("trailer declares 4 base records, file has 3");
  });

  it("rejects truncated records", () => {
    const file = buildMetro2File([account({})], FURNISHER, NOW);
    const broken = [file.records[0], file.records[1].slice(0, 400), file.records[2]].join("\n");
    expect(validateMetro2File(broken)[0]).toMatch(/length 400/);
  });
});

describe("furnishMetro2File", () => {
  beforeEach(() => logAuditMock.mockReset());

  it("stores a copy, delivers it and logs the submission with its record count", async () => {
    const store = createInMemoryMetro2FileStore();
    const deliver = jest.fn().mockResolvedValue(undefined);

    const { file, stored } = await furnishMetro2File(FIXTURES, FURNISHER, { store, deliver, now: NOW });

    expect(store.files).toHaveLength(1);
    expect(store.files[0].content).toBe(file.content);
    expect(deliver).toHaveBeenCalledWith(file);
    expect(logAuditMock).toHaveBeenCalledWith({
      action: "credit_bureau_metro2_submission",
      metadata: expect.objectContaining({ fileId: stored.id, recordCount: 4, excludedCount: 2 }),
    });
  });

  it("does not store, deliver or log an invalid file", async () => {
    const store = createInMemoryMetro2FileStore();
    const deliver = jest.fn();
    // A surname of only punctuation is stripped to blank, which fails validation.
    const bad = account({ surname: "###" });

    await expect(furnishMetro2File([bad], FURNISHER, { store, deliver, now: NOW })).rejects.toBeInstanceOf(
      Metro2ValidationError
    );
    expect(store.files).toHaveLength(0);
    expect(deliver).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});
