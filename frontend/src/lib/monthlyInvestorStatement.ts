// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Monthly investor statements (issue #1113).
 *
 * An investor's statement for a calendar month summarizes deposits,
 * withdrawals, yield earned and the closing balance. Every figure is a sum over
 * the investor's recorded transactions — nothing is re-derived from rates or
 * pool share — so the statement can never drift from the ledger:
 *
 *   opening = net of every recorded transaction before the month
 *   closing = opening + deposits − withdrawals + yield   (same records)
 *
 * All arithmetic runs in bigint stroops, matching the annual interest
 * statement, so totals agree with the individual transactions to the stroop.
 */

import type { StatementMetadata, StatementPayload, StatementRow } from "./statementExport";
import { formatStroops } from "./amortization";

export type InvestorTransactionType = "deposit" | "withdrawal" | "yield";

/** A recorded investor transaction, amounts in stroops (always positive). */
export interface InvestorTransaction {
  id: string;
  type: InvestorTransactionType;
  /** ISO-8601 settlement timestamp. */
  date: string;
  amount: bigint;
  txHash?: string;
}

/** `YYYY-MM`, UTC. */
export type StatementMonth = string;

export interface MonthlyInvestorStatement {
  month: StatementMonth;
  /** ISO-8601 start of the month (inclusive), UTC. */
  periodStart: string;
  /** ISO-8601 start of the next month (exclusive), UTC. */
  periodEnd: string;
  openingBalance: bigint;
  deposits: bigint;
  withdrawals: bigint;
  yieldEarned: bigint;
  closingBalance: bigint;
  /** Every transaction recorded in the month, chronological. */
  transactions: InvestorTransaction[];
}

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** UTC month key for a timestamp. */
export function toStatementMonth(date: string | Date): StatementMonth {
  const d = typeof date === "string" ? new Date(date) : date;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthBounds(month: StatementMonth): { start: Date; end: Date } {
  const match = MONTH_PATTERN.exec(month);
  if (!match) throw new Error(`Invalid statement month: ${month}`);
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  return {
    start: new Date(Date.UTC(year, monthIndex, 1)),
    end: new Date(Date.UTC(year, monthIndex + 1, 1)),
  };
}

/** Signed effect of a transaction on the investor's balance. */
export function signedAmount(transaction: InvestorTransaction): bigint {
  return transaction.type === "withdrawal" ? -transaction.amount : transaction.amount;
}

/**
 * Every completed calendar month the account has been open, newest first:
 * from the month the account opened up to, but excluding, the current month.
 */
export function listStatementMonths(accountOpenedAt: string, now: Date = new Date()): StatementMonth[] {
  const opened = new Date(accountOpenedAt);
  if (Number.isNaN(opened.getTime())) return [];

  const months: StatementMonth[] = [];
  const cursor = new Date(Date.UTC(opened.getUTCFullYear(), opened.getUTCMonth(), 1));
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  while (cursor < currentMonthStart) {
    months.push(toStatementMonth(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months.reverse();
}

/** Builds one month's statement directly from the recorded transactions. */
export function buildMonthlyInvestorStatement(
  transactions: InvestorTransaction[],
  month: StatementMonth
): MonthlyInvestorStatement {
  const { start, end } = monthBounds(month);

  let openingBalance = 0n;
  let deposits = 0n;
  let withdrawals = 0n;
  let yieldEarned = 0n;
  const inMonth: InvestorTransaction[] = [];

  for (const transaction of transactions) {
    const at = Date.parse(transaction.date);
    if (Number.isNaN(at) || at >= end.getTime()) continue;
    if (at < start.getTime()) {
      openingBalance += signedAmount(transaction);
      continue;
    }
    inMonth.push(transaction);
    if (transaction.type === "deposit") deposits += transaction.amount;
    else if (transaction.type === "withdrawal") withdrawals += transaction.amount;
    else yieldEarned += transaction.amount;
  }

  inMonth.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id));

  return {
    month,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    openingBalance,
    deposits,
    withdrawals,
    yieldEarned,
    closingBalance: openingBalance + deposits - withdrawals + yieldEarned,
    transactions: inMonth,
  };
}

/** Human-readable month label, e.g. "March 2026". */
export function formatStatementMonth(month: StatementMonth): string {
  return monthBounds(month).start.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Formats stroops at full 7-decimal precision (trailing zeros trimmed to two
 * decimals) so a printed figure is never rounded away from the ledger value.
 */
export function formatUsdc(stroops: bigint): string {
  const full = formatStroops(stroops, 7);
  return `${full.replace(/(\.\d{2}\d*?)0+$/, "$1")} USDC`;
}

const TYPE_LABELS: Record<InvestorTransactionType, string> = {
  deposit: "Deposit",
  withdrawal: "Withdrawal",
  yield: "Yield",
};

/** Statement payload ready for `downloadStatementPdf` / `buildStatementPdf`. */
export function buildMonthlyInvestorStatementPayload(
  statement: MonthlyInvestorStatement,
  metadata: StatementMetadata
): StatementPayload {
  const rows: StatementRow[] = statement.transactions.map((transaction) => ({
    date: new Date(transaction.date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }),
    type: TYPE_LABELS[transaction.type],
    amount: `${transaction.type === "withdrawal" ? "-" : ""}${formatUsdc(transaction.amount)}`,
    status: "Completed",
    reference: transaction.txHash ?? transaction.id,
    counterparty: "RemitMortgage lending pool",
  }));

  return {
    title: `Monthly Investor Statement - ${formatStatementMonth(statement.month)}`,
    subtitle:
      "Deposits, withdrawals and yield recorded for this account during the month, with opening and closing balances.",
    metadata,
    metadataHeading: "Investor account",
    emptyRowsMessage: "No activity was recorded on this account during the month.",
    summary: [
      { label: "Statement Period", value: formatStatementMonth(statement.month) },
      { label: "Opening Balance", value: formatUsdc(statement.openingBalance) },
      { label: "Deposits", value: formatUsdc(statement.deposits) },
      { label: "Withdrawals", value: formatUsdc(statement.withdrawals) },
      { label: "Yield Earned", value: formatUsdc(statement.yieldEarned) },
      { label: "Closing Balance", value: formatUsdc(statement.closingBalance) },
      { label: "Transactions Recorded", value: String(statement.transactions.length) },
    ],
    rows,
  };
}

/** Filename for a month's statement PDF. */
export function monthlyStatementFilename(month: StatementMonth): string {
  return `Investor_Statement_${month}.pdf`;
}
