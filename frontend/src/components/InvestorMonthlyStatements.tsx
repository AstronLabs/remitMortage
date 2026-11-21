"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useMemo, useState } from "react";
import { Download, FileText } from "lucide-react";
import {
  buildMonthlyInvestorStatement,
  formatStatementMonth,
  formatUsdc,
  listStatementMonths,
  type InvestorTransaction,
  type MonthlyInvestorStatement,
  type StatementMonth,
} from "@/lib/monthlyInvestorStatement";

export interface InvestorMonthlyStatementsProps {
  transactions: InvestorTransaction[];
  /** ISO-8601 timestamp the investor's account was opened. */
  accountOpenedAt: string;
  /** Called with the month's statement when the investor downloads it. */
  onDownload: (statement: MonthlyInvestorStatement) => void;
  /** Injectable clock (tests). */
  now?: Date;
}

const TYPE_LABELS = { deposit: "Deposit", withdrawal: "Withdrawal", yield: "Yield" } as const;

function StatementFigures({ statement }: { statement: MonthlyInvestorStatement }) {
  const figures = [
    { label: "Opening balance", value: statement.openingBalance, testId: "opening" },
    { label: "Deposits", value: statement.deposits, testId: "deposits" },
    { label: "Withdrawals", value: statement.withdrawals, testId: "withdrawals" },
    { label: "Yield earned", value: statement.yieldEarned, testId: "yield" },
    { label: "Closing balance", value: statement.closingBalance, testId: "closing" },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {figures.map((figure) => (
        <div
          key={figure.testId}
          className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] p-3"
        >
          <dt className="text-xs uppercase tracking-wider text-[var(--text-muted)]">
            {figure.label}
          </dt>
          <dd
            data-testid={`statement-${figure.testId}`}
            className="mt-1 font-semibold tabular-nums text-white"
          >
            {formatUsdc(figure.value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default function InvestorMonthlyStatements({
  transactions,
  accountOpenedAt,
  onDownload,
  now,
}: InvestorMonthlyStatementsProps) {
  const months = useMemo(() => listStatementMonths(accountOpenedAt, now), [accountOpenedAt, now]);
  const statements = useMemo(
    () => months.map((month) => buildMonthlyInvestorStatement(transactions, month)),
    [months, transactions]
  );
  const [selectedMonth, setSelectedMonth] = useState<StatementMonth | null>(null);
  const selected =
    statements.find((statement) => statement.month === selectedMonth) ?? statements[0] ?? null;

  if (statements.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-10 text-center">
        <h2 className="mb-2 text-lg font-semibold">No statements yet</h2>
        <p className="mx-auto max-w-md text-sm text-[var(--text-secondary)]">
          Your first monthly statement will be available once your first full calendar month has
          ended.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
      <section aria-labelledby="statement-list-heading">
        <h2 id="statement-list-heading" className="mb-3 text-sm font-semibold text-slate-300">
          Available statements
        </h2>
        <ul className="space-y-2" data-testid="statement-month-list">
          {statements.map((statement) => {
            const label = formatStatementMonth(statement.month);
            const isSelected = selected?.month === statement.month;
            return (
              <li
                key={statement.month}
                className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 ${
                  isSelected
                    ? "border-cyan-500/50 bg-cyan-500/10"
                    : "border-[var(--border-color)] bg-[var(--bg-card)]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedMonth(statement.month)}
                  aria-pressed={isSelected}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm text-slate-200"
                >
                  <FileText className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {label}
                </button>
                <button
                  type="button"
                  onClick={() => onDownload(statement)}
                  aria-label={`Download ${label} statement as PDF`}
                  className="rounded-md p-1.5 text-cyan-300 hover:bg-cyan-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {selected && (
        <section
          aria-labelledby="statement-detail-heading"
          data-testid="statement-detail"
          className="space-y-5 rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="statement-detail-heading" className="text-xl font-bold text-white">
              {formatStatementMonth(selected.month)}
            </h2>
            <button
              type="button"
              onClick={() => onDownload(selected)}
              className="rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-cyan-500/20 transition hover:from-cyan-400 hover:to-blue-500"
            >
              Download PDF
            </button>
          </div>

          <StatementFigures statement={selected} />

          {selected.transactions.length === 0 ? (
            <p data-testid="statement-no-activity" className="text-sm text-[var(--text-secondary)]">
              No activity was recorded on this account during the month.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border-color)] text-xs uppercase tracking-wider text-[var(--text-muted)]">
                    <th className="px-4 py-3 text-left font-medium">Date</th>
                    <th className="px-4 py-3 text-left font-medium">Type</th>
                    <th className="px-4 py-3 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.transactions.map((transaction) => (
                    <tr
                      key={transaction.id}
                      className="border-b border-[var(--border-color)]/40 last:border-0"
                    >
                      <td className="whitespace-nowrap px-4 py-3 text-[var(--text-secondary)]">
                        {new Date(transaction.date).toLocaleDateString("en-US", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                          timeZone: "UTC",
                        })}
                      </td>
                      <td className="px-4 py-3">{TYPE_LABELS[transaction.type]}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {transaction.type === "withdrawal" ? "-" : ""}
                        {formatUsdc(transaction.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
