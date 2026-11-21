// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Credit bureau furnishing export in Metro 2 format (issue #920).
 *
 * Builds a fixed-width, 426-character file made of one Header record, one
 * Base Segment per reportable account and one Trailer record. Only borrowers
 * who gave reporting consent are included, and accounts whose dispute is
 * flagged for correction are held back until the correction is made.
 *
 * Fields the platform does not collect (SSN, date of birth, postal address…)
 * are blank-filled, which is what Metro 2 expects for unknown values. The file
 * is validated before it is stored, and every submission is logged with its
 * record count.
 */

import crypto from "crypto";
import { logAudit } from "./audit.js";

export const METRO2_RECORD_LENGTH = 426;
const RDW = String(METRO2_RECORD_LENGTH).padStart(4, "0");

/** Account status codes used by this furnisher (Metro 2 field 17A). */
export const METRO2_ACCOUNT_STATUS = {
  CURRENT: "11",
  PAID_OFF: "13",
  LATE_30: "71",
  LATE_60: "78",
  LATE_90: "80",
  LATE_120: "82",
  LATE_150: "83",
  LATE_180: "84",
} as const;
const VALID_STATUSES = new Set<string>(Object.values(METRO2_ACCOUNT_STATUS));

/** Compliance Condition Code for "account information disputed by consumer". */
export const METRO2_DISPUTED_CCC = "XB";

export interface Metro2Account {
  loanId: string;
  borrowerId: string;
  surname: string;
  firstName: string;
  /** Borrower agreed to have this loan reported to credit bureaus. */
  reportingConsent: boolean;
  /** Borrower disputes the account information. */
  disputed?: boolean;
  /** A dispute was upheld and the data must be corrected before reporting again. */
  flaggedForCorrection?: boolean;
  openedAt: Date;
  originalAmount: number;
  termMonths: number;
  scheduledMonthlyPayment: number;
  lastPaymentAmount: number;
  lastPaymentAt?: Date | null;
  currentBalance: number;
  amountPastDue: number;
  daysPastDue: number;
  closedAt?: Date | null;
  /** Date of first delinquency, required by FCRA when the account is late. */
  firstDelinquencyAt?: Date | null;
}

export interface Metro2Furnisher {
  /** Identification number assigned by the bureaus (field 5). */
  identificationNumber: string;
  reporterName: string;
  cycleIdentifier?: string;
}

export interface Metro2File {
  content: string;
  records: string[];
  /** Number of Base Segment records (excludes header and trailer). */
  recordCount: number;
  includedLoanIds: string[];
  excluded: { loanId: string; reason: "no_consent" | "dispute_flagged_for_correction" }[];
  sha256: string;
  generatedAt: Date;
}

type Field = { len: number; value: string; numeric?: boolean };

function mmddyyyy(date: Date | null | undefined): string {
  if (!date) return "00000000";
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${mm}${dd}${date.getUTCFullYear()}`;
}

function timestamp(date: Date): string {
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${mmddyyyy(date)}${hh}${mi}${ss}`;
}

/** Whole dollars, as Metro 2 money fields carry no decimals. */
function money(amount: number): string {
  return String(Math.max(0, Math.round(amount)));
}

function alpha(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9 \-'.]/g, "");
}

function renderFields(fields: Field[]): string {
  const line = fields
    .map(({ len, value, numeric }) =>
      numeric ? value.slice(-len).padStart(len, "0") : value.slice(0, len).padEnd(len, " ")
    )
    .join("");
  return line.padEnd(METRO2_RECORD_LENGTH, " ");
}

export function accountStatusFor(account: Metro2Account): string {
  if (account.currentBalance <= 0 && account.closedAt) return METRO2_ACCOUNT_STATUS.PAID_OFF;
  const d = account.daysPastDue;
  if (d < 30) return METRO2_ACCOUNT_STATUS.CURRENT;
  if (d < 60) return METRO2_ACCOUNT_STATUS.LATE_30;
  if (d < 90) return METRO2_ACCOUNT_STATUS.LATE_60;
  if (d < 120) return METRO2_ACCOUNT_STATUS.LATE_90;
  if (d < 150) return METRO2_ACCOUNT_STATUS.LATE_120;
  if (d < 180) return METRO2_ACCOUNT_STATUS.LATE_150;
  return METRO2_ACCOUNT_STATUS.LATE_180;
}

function headerRecord(furnisher: Metro2Furnisher, now: Date): string {
  return renderFields([
    { len: 4, value: RDW, numeric: true },
    { len: 6, value: "HEADER" },
    { len: 2, value: furnisher.cycleIdentifier ?? "" },
    { len: 10, value: "" }, // Innovis program identifier
    { len: 10, value: "" }, // Equifax program identifier
    { len: 5, value: "" }, // Experian program identifier
    { len: 10, value: "" }, // TransUnion program identifier
    { len: 8, value: mmddyyyy(now), numeric: true }, // activity date
    { len: 8, value: mmddyyyy(now), numeric: true }, // date created
    { len: 8, value: "00000000", numeric: true }, // program date
    { len: 8, value: "00000000", numeric: true }, // program revision date
    { len: 40, value: alpha(furnisher.reporterName) },
  ]);
}

function baseSegment(account: Metro2Account, furnisher: Metro2Furnisher, now: Date): string {
  const status = accountStatusFor(account);
  return renderFields([
    { len: 4, value: RDW, numeric: true },
    { len: 1, value: "1" }, // processing indicator
    { len: 14, value: timestamp(now), numeric: true },
    { len: 1, value: "0" }, // correction indicator
    { len: 20, value: furnisher.identificationNumber },
    { len: 2, value: furnisher.cycleIdentifier ?? "" },
    { len: 30, value: account.loanId },
    { len: 1, value: "M" }, // portfolio type: mortgage
    { len: 2, value: "26" }, // account type: conventional real estate mortgage
    { len: 8, value: mmddyyyy(account.openedAt), numeric: true },
    { len: 9, value: "0", numeric: true }, // credit limit
    { len: 9, value: money(account.originalAmount), numeric: true },
    { len: 3, value: String(account.termMonths), numeric: true },
    { len: 1, value: "M" }, // terms frequency: monthly
    { len: 9, value: money(account.scheduledMonthlyPayment), numeric: true },
    { len: 9, value: money(account.lastPaymentAmount), numeric: true },
    { len: 2, value: status },
    { len: 1, value: "" }, // payment rating
    { len: 24, value: "" }, // payment history profile
    { len: 2, value: "" }, // special comment
    { len: 2, value: account.disputed ? METRO2_DISPUTED_CCC : "" },
    { len: 9, value: money(account.currentBalance), numeric: true },
    { len: 9, value: money(account.amountPastDue), numeric: true },
    { len: 9, value: "0", numeric: true }, // original charge-off amount
    { len: 8, value: mmddyyyy(now), numeric: true }, // date of account information
    {
      len: 8,
      value: status === METRO2_ACCOUNT_STATUS.CURRENT || status === METRO2_ACCOUNT_STATUS.PAID_OFF
        ? "00000000"
        : mmddyyyy(account.firstDelinquencyAt),
      numeric: true,
    },
    { len: 8, value: mmddyyyy(account.closedAt), numeric: true },
    { len: 8, value: mmddyyyy(account.lastPaymentAt), numeric: true },
    { len: 1, value: "F" }, // interest type: fixed
    { len: 16, value: "" }, // reserved
    { len: 25, value: alpha(account.surname) },
    { len: 20, value: alpha(account.firstName) },
  ]);
}

function trailerRecord(baseCount: number, statusCounts: Map<string, number>): string {
  const count = (s: string) => String(statusCounts.get(s) ?? 0);
  return renderFields([
    { len: 4, value: RDW, numeric: true },
    { len: 7, value: "TRAILER" },
    { len: 9, value: String(baseCount), numeric: true },
    { len: 9, value: count(METRO2_ACCOUNT_STATUS.CURRENT), numeric: true },
    { len: 9, value: count(METRO2_ACCOUNT_STATUS.PAID_OFF), numeric: true },
    {
      len: 9,
      value: String(baseCount - (statusCounts.get("11") ?? 0) - (statusCounts.get("13") ?? 0)),
      numeric: true,
    },
  ]);
}

/** Builds the furnishing file. Pure: no storage or logging. */
export function buildMetro2File(
  accounts: Metro2Account[],
  furnisher: Metro2Furnisher,
  now: Date = new Date()
): Metro2File {
  const excluded: Metro2File["excluded"] = [];
  const included: Metro2Account[] = [];
  for (const account of accounts) {
    if (!account.reportingConsent) {
      excluded.push({ loanId: account.loanId, reason: "no_consent" });
    } else if (account.disputed && account.flaggedForCorrection) {
      excluded.push({ loanId: account.loanId, reason: "dispute_flagged_for_correction" });
    } else {
      included.push(account);
    }
  }

  const statusCounts = new Map<string, number>();
  const bases = included.map((account) => {
    const status = accountStatusFor(account);
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    return baseSegment(account, furnisher, now);
  });

  const records = [headerRecord(furnisher, now), ...bases, trailerRecord(bases.length, statusCounts)];
  const content = records.join("\n") + "\n";
  return {
    content,
    records,
    recordCount: bases.length,
    includedLoanIds: included.map((a) => a.loanId),
    excluded,
    sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
    generatedAt: now,
  };
}

/** Returns a list of problems; an empty list means the file is valid. */
export function validateMetro2File(content: string): string[] {
  const errors: string[] = [];
  const records = content.split("\n").filter((line) => line.length > 0);
  if (records.length < 2) return ["file must contain a header and a trailer record"];

  records.forEach((record, i) => {
    if (record.length !== METRO2_RECORD_LENGTH) {
      errors.push(`record ${i + 1}: length ${record.length}, expected ${METRO2_RECORD_LENGTH}`);
    }
    if (record.slice(0, 4) !== RDW) errors.push(`record ${i + 1}: bad record descriptor word`);
  });

  if (records[0].slice(4, 10) !== "HEADER") errors.push("first record must be the HEADER");
  const trailer = records[records.length - 1];
  if (trailer.slice(4, 11) !== "TRAILER") errors.push("last record must be the TRAILER");

  const bases = records.slice(1, -1);
  const declared = Number(trailer.slice(11, 20));
  if (declared !== bases.length) {
    errors.push(`trailer declares ${declared} base records, file has ${bases.length}`);
  }

  bases.forEach((record, i) => {
    const n = i + 2;
    if (!/^\d{14}$/.test(record.slice(5, 19))) errors.push(`record ${n}: invalid time stamp`);
    if (record.slice(42, 72).trim() === "") errors.push(`record ${n}: missing account number`);
    if (!VALID_STATUSES.has(record.slice(123, 125))) errors.push(`record ${n}: invalid account status`);
    for (const [start, end] of [[92, 101], [154, 163], [163, 172]]) {
      if (!/^\d+$/.test(record.slice(start, end))) errors.push(`record ${n}: non-numeric amount at ${start + 1}`);
    }
    if (record.slice(230, 255).trim() === "") errors.push(`record ${n}: missing surname`);
  });

  return errors;
}

export class Metro2ValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(`Metro 2 file failed validation: ${errors.join("; ")}`);
    this.name = "Metro2ValidationError";
  }
}

export interface StoredMetro2File {
  id: string;
  sha256: string;
  recordCount: number;
  content: string;
  storedAt: Date;
}

/** Where copies of delivered files are kept. Swap for object storage in production. */
export interface Metro2FileStore {
  save(file: Omit<StoredMetro2File, "id" | "storedAt">): Promise<StoredMetro2File>;
}

export function createInMemoryMetro2FileStore(): Metro2FileStore & { files: StoredMetro2File[] } {
  const files: StoredMetro2File[] = [];
  return {
    files,
    async save(file) {
      const stored = { ...file, id: `metro2-${files.length + 1}-${file.sha256.slice(0, 12)}`, storedAt: new Date() };
      files.push(stored);
      return stored;
    },
  };
}

export interface FurnishMetro2Deps {
  store: Metro2FileStore;
  /** Hands the validated file to the bureau channel (SFTP etc.). */
  deliver?: (file: Metro2File) => Promise<void>;
  log?: typeof logAudit;
  now?: Date;
}

/**
 * Builds, validates, stores and (optionally) delivers one furnishing file,
 * then logs the submission with its record count. Throws
 * {@link Metro2ValidationError} without storing or delivering when the file
 * is invalid.
 */
export async function furnishMetro2File(
  accounts: Metro2Account[],
  furnisher: Metro2Furnisher,
  deps: FurnishMetro2Deps
): Promise<{ file: Metro2File; stored: StoredMetro2File }> {
  const file = buildMetro2File(accounts, furnisher, deps.now);
  const errors = validateMetro2File(file.content);
  if (errors.length > 0) throw new Metro2ValidationError(errors);

  const stored = await deps.store.save({
    sha256: file.sha256,
    recordCount: file.recordCount,
    content: file.content,
  });
  if (deps.deliver) await deps.deliver(file);

  await (deps.log ?? logAudit)({
    action: "credit_bureau_metro2_submission",
    metadata: {
      fileId: stored.id,
      sha256: file.sha256,
      recordCount: file.recordCount,
      excludedCount: file.excluded.length,
      generatedAt: file.generatedAt.toISOString(),
      delivered: Boolean(deps.deliver),
    },
  });

  return { file, stored };
}
