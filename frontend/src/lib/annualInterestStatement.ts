// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Annual mortgage interest statement aggregation.
 *
 * Borrowers need a year-end summary of how much principal and interest they
 * actually paid across *all* of their loans in a calendar year — the borrower
 * analogue of a traditional lender's year-end mortgage interest statement.
 *
 * Repayments are already split into principal and interest portions by the
 * settlement layer (each on-chain repayment carries its flat-interest split),
 * so this module only has to filter by calendar year and total the splits up
 * per loan and combined. All arithmetic runs in bigint stroops so the totals in
 * the exported statement match the individual repayments to the last stroop.
 */

import type {
  StatementMetadata,
  StatementPayload,
  StatementRow,
} from "./statementExport";
import { STROOPS_PER_UNIT, formatStroops } from "./amortization";

/** A settled repayment with its principal/interest breakdown, in stroops. */
export interface AnnualRepayment {
  id: string;
  /** Stable loan identifier — repayments sharing one are summed together. */
  loanId: string;
  /** Human-readable loan label shown in the statement. */
  loanName: string;
  /** ISO-8601 settlement timestamp. */
  date: string;
  /** Total amount paid, in stroops. */
  amount: bigint;
  /** Portion of `amount` that retired loan principal, in stroops. */
  principal: bigint;
  /** Portion of `amount` that covered interest, in stroops. */
  interest: bigint;
  /** Optional on-chain transaction hash for the repayment. */
  txHash?: string;
}

/** Per-loan annual totals rolled up from that loan's repayments. */
export interface LoanAnnualTotals {
  loanId: string;
  loanName: string;
  principalPaid: bigint;
  interestPaid: bigint;
  totalPaid: bigint;
  repaymentCount: number;
}

/** Combined totals across every loan for the selected year. */
export interface CombinedAnnualTotals {
  principalPaid: bigint;
  interestPaid: bigint;
  totalPaid: bigint;
  repaymentCount: number;
  loanCount: number;
}

export interface AnnualInterestStatement {
  year: number;
  /** One entry per loan that has at least one repayment in `year`. */
  loans: LoanAnnualTotals[];
  combined: CombinedAnnualTotals;
  /** Every repayment in the year, chronological, across all loans. */
  repayments: AnnualRepayment[];
}

/**
 * Parses a whole-token amount (e.g. `"1250.50"`) into stroops.
 *
 * Values are token amounts as strings so the 7-decimal Stellar precision is
 * preserved end to end; anything that is not a plain decimal returns `0n`
 * rather than throwing, keeping aggregation resilient to malformed rows.
 */
export function parseTokenAmount(value: string | number): bigint {
  const text = (typeof value === "number" ? value.toString() : value).trim();
  if (!/^-?\d*(\.\d*)?$/.test(text) || text === "" || text === "-" || text === ".") {
    return 0n;
  }

  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [wholePart = "0", fractionPart = ""] = unsigned.split(".");

  const whole = wholePart === "" ? 0n : BigInt(wholePart);
  const fraction = BigInt((fractionPart + "0000000").slice(0, 7));
  const stroops = whole * STROOPS_PER_UNIT + fraction;

  return negative ? -stroops : stroops;
}

/** Reads the UTC calendar year from an ISO-8601 timestamp. */
export function repaymentYear(date: string): number {
  return new Date(date).getUTCFullYear();
}

/**
 * Aggregates a borrower's repayments into per-loan and combined annual totals
 * for the selected calendar year.
 *
 * Repayments outside `year` are ignored. A loan with no repayments in `year` is
 * omitted entirely, so a borrower with multiple loans only sees the loans that
 * were actually serviced that year alongside the combined total across them.
 */
export function buildAnnualInterestStatement(
  repayments: AnnualRepayment[],
  year: number
): AnnualInterestStatement {
  const inYear = repayments
    .filter((repayment) => repaymentYear(repayment.date) === year)
    .sort((a, b) => a.date.localeCompare(b.date));

  const perLoan = new Map<string, LoanAnnualTotals>();

  for (const repayment of inYear) {
    const existing = perLoan.get(repayment.loanId);
    if (existing) {
      existing.principalPaid += repayment.principal;
      existing.interestPaid += repayment.interest;
      existing.totalPaid += repayment.amount;
      existing.repaymentCount += 1;
    } else {
      perLoan.set(repayment.loanId, {
        loanId: repayment.loanId,
        loanName: repayment.loanName,
        principalPaid: repayment.principal,
        interestPaid: repayment.interest,
        totalPaid: repayment.amount,
        repaymentCount: 1,
      });
    }
  }

  const loans = Array.from(perLoan.values());

  const combined: CombinedAnnualTotals = loans.reduce<CombinedAnnualTotals>(
    (totals, loan) => ({
      principalPaid: totals.principalPaid + loan.principalPaid,
      interestPaid: totals.interestPaid + loan.interestPaid,
      totalPaid: totals.totalPaid + loan.totalPaid,
      repaymentCount: totals.repaymentCount + loan.repaymentCount,
      loanCount: totals.loanCount + 1,
    }),
    {
      principalPaid: 0n,
      interestPaid: 0n,
      totalPaid: 0n,
      repaymentCount: 0,
      loanCount: 0,
    }
  );

  return { year, loans, combined, repayments: inYear };
}

/** Formats a stroop total with the protocol's canonical token ticker. */
function formatAmount(stroops: bigint): string {
  return `${formatStroops(stroops)} USDC`;
}

/**
 * Builds the shared statement payload for the borrower's annual interest
 * statement, ready for `downloadStatementPdf` / `downloadStatementCsv`.
 *
 * The summary carries the combined totals plus a per-loan principal/interest
 * breakdown, and the rows list one annual-total row per loan followed by every
 * underlying repayment — so a multi-loan borrower sees both views in the PDF.
 */
export function buildAnnualInterestStatementPayload(
  statement: AnnualInterestStatement,
  metadata: StatementMetadata
): StatementPayload {
  const rows: StatementRow[] = [];

  for (const loan of statement.loans) {
    rows.push({
      date: `Year ${statement.year}`,
      type: "Loan Annual Total",
      amount: formatAmount(loan.totalPaid),
      status: "Summary",
      reference: loan.loanId,
      counterparty: loan.loanName,
      notes: `Principal ${formatAmount(loan.principalPaid)} · Interest ${formatAmount(
        loan.interestPaid
      )}`,
    });
  }

  for (const repayment of statement.repayments) {
    rows.push({
      date: new Date(repayment.date).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
      type: "Repayment",
      amount: formatAmount(repayment.amount),
      status: "Completed",
      reference: repayment.txHash ?? repayment.id,
      counterparty: repayment.loanName,
      notes: `Principal ${formatAmount(repayment.principal)} · Interest ${formatAmount(
        repayment.interest
      )}`,
    });
  }

  return {
    title: `Annual Mortgage Interest Statement - ${statement.year}`,
    subtitle:
      "Borrower year-end summary of principal and interest paid across all mortgage loans.",
    metadata,
    summary: [
      { label: "Calendar Year", value: String(statement.year) },
      { label: "Combined Principal Paid", value: formatAmount(statement.combined.principalPaid) },
      { label: "Combined Interest Paid", value: formatAmount(statement.combined.interestPaid) },
      { label: "Combined Total Paid", value: formatAmount(statement.combined.totalPaid) },
      { label: "Repayments Recorded", value: String(statement.combined.repaymentCount) },
      { label: "Loans Covered", value: String(statement.combined.loanCount) },
      ...statement.loans.flatMap((loan) => [
        { label: `${loan.loanName} — Principal`, value: formatAmount(loan.principalPaid) },
        { label: `${loan.loanName} — Interest`, value: formatAmount(loan.interestPaid) },
        { label: `${loan.loanName} — Total`, value: formatAmount(loan.totalPaid) },
      ]),
    ],
    rows,
  };
}
