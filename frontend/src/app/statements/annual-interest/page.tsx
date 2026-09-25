"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

export const dynamic = "force-dynamic";

import React, { useEffect, useMemo, useState } from "react";
import dynamicImport from "next/dynamic";
import { OptionalWalletProvider, useWallet } from "@/context/WalletContext";
import {
  buildAnnualInterestStatement,
  buildAnnualInterestStatementPayload,
  parseTokenAmount,
  repaymentYear,
  type AnnualRepayment,
} from "@/lib/annualInterestStatement";
import {
  createStatementMetadata,
  downloadStatementCsv,
  downloadStatementPdf,
} from "@/lib/statementExport";
import { formatStroops } from "@/lib/amortization";
import type { BorrowerRepaymentRecord } from "@/app/api/borrower/[publicKey]/repayments/route";

const Navbar = dynamicImport(() => import("@/components/Navbar"), { ssr: false });

function shorten(address: string) {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}\u2026${address.slice(-4)}`;
}

function formatAmount(stroops: bigint) {
  return `${formatStroops(stroops)} USDC`;
}

function toAnnualRepayment(record: BorrowerRepaymentRecord): AnnualRepayment {
  return {
    id: record.id,
    loanId: record.loanId,
    loanName: record.loanName,
    date: record.date,
    amount: parseTokenAmount(record.amount),
    principal: parseTokenAmount(record.principal),
    interest: parseTokenAmount(record.interest),
    txHash: record.txHash,
  };
}

function AnnualInterestStatementInner() {
  const { publicKey } = useWallet();

  const [repayments, setRepayments] = useState<AnnualRepayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedYear, setSelectedYear] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const address = publicKey ?? "demo-borrower";
        const res = await fetch(`/api/borrower/${address}/repayments`);
        if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
        const data = await res.json();
        const parsed: AnnualRepayment[] = Array.isArray(data?.repayments)
          ? (data.repayments as BorrowerRepaymentRecord[]).map(toAnnualRepayment)
          : [];
        if (!cancelled) setRepayments(parsed);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load repayment history");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [publicKey]);

  const availableYears = useMemo(
    () =>
      Array.from(new Set(repayments.map((repayment) => repaymentYear(repayment.date)))).sort(
        (a, b) => b - a
      ),
    [repayments]
  );

  // Default to the most recent year with activity until the borrower picks one.
  const activeYear = selectedYear ?? availableYears[0] ?? null;

  const statement = useMemo(
    () => (activeYear === null ? null : buildAnnualInterestStatement(repayments, activeYear)),
    [repayments, activeYear]
  );

  const statementMetadata = useMemo(
    () =>
      createStatementMetadata({
        borrowerName: publicKey ? `Wallet ${shorten(publicKey)}` : "Borrower (demo wallet)",
        borrowerAddress: publicKey ?? "STELLAR-PUBLIC-KEY-NOT-CONNECTED",
        walletType: "Freighter / Stellar",
      }),
    [publicKey]
  );

  function handleExportPdf() {
    if (!statement) return;
    const payload = buildAnnualInterestStatementPayload(statement, statementMetadata);
    downloadStatementPdf(payload, `Annual_Mortgage_Interest_Statement_${statement.year}.pdf`);
  }

  function handleExportCsv() {
    if (!statement) return;
    const payload = buildAnnualInterestStatementPayload(statement, statementMetadata);
    downloadStatementCsv(payload, `Annual_Mortgage_Interest_Statement_${statement.year}.csv`);
  }

  const hasData = statement !== null && statement.combined.repaymentCount > 0;

  return (
    <div className="rm-app-page rm-repay-page min-h-screen bg-[#060913] text-slate-100 pb-20">
      <Navbar />

      <main className="max-w-7xl mx-auto px-6 pt-32 pb-20">
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 mb-8 print:mb-4">
          <div>
            <span className="no-print inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-cyan-500/10 text-cyan-400 text-xs font-semibold uppercase tracking-wider mb-3 border border-cyan-500/20">
              Year-End Borrower Records
            </span>
            <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight text-white mb-2">
              Annual Mortgage <span className="gradient-text">Interest Statement</span>
            </h1>
            <p className="text-slate-400 text-sm md:text-base max-w-2xl">
              Select a calendar year to see how your repayments split between principal and
              interest, per loan and combined. Download a print-friendly PDF for your records.
            </p>
          </div>

          <div className="no-print flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <span className="text-slate-400">Tax Year</span>
              <select
                aria-label="Select statement year"
                value={activeYear ?? ""}
                onChange={(e) => setSelectedYear(Number(e.target.value))}
                disabled={availableYears.length === 0}
                className="px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-sm text-slate-200 focus:outline-none focus:border-cyan-500/50 disabled:opacity-50"
              >
                {availableYears.length === 0 && <option value="">No years</option>}
                {availableYears.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              onClick={handleExportPdf}
              disabled={!hasData}
              className="px-5 py-2.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white text-sm font-bold shadow-lg shadow-cyan-500/20 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Download PDF
            </button>
            <button
              type="button"
              onClick={handleExportCsv}
              disabled={!hasData}
              className="px-4 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-semibold transition border border-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Export CSV
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              disabled={!hasData}
              className="px-4 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-semibold transition border border-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Print
            </button>
          </div>
        </div>

        {loading && (
          <div className="p-6 bg-[var(--bg-card)] rounded-lg text-sm text-[var(--text-muted)]">
            Loading repayment history{"\u2026"}
          </div>
        )}

        {error && !loading && (
          <div
            role="alert"
            className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400"
          >
            {error}
          </div>
        )}

        {!loading && !error && !hasData && (
          <div className="p-10 bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)] text-center">
            <h2 className="text-lg font-semibold mb-2">No repayments for this year</h2>
            <p className="text-sm text-[var(--text-secondary)] max-w-md mx-auto">
              There are no recorded repayments for the selected calendar year. Choose another year
              or make a repayment to populate your statement.
            </p>
          </div>
        )}

        {!loading && !error && hasData && statement && (
          <div className="space-y-8">
            {/* Statement header (also the print masthead) */}
            <section className="statement-section avoid-page-break p-6 rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)]">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-widest text-cyan-400 font-semibold">
                    RemitMortgage Protocol
                  </p>
                  <h2 className="text-2xl font-bold text-white">
                    Annual Mortgage Interest Statement
                  </h2>
                  <p className="text-sm text-[var(--text-muted)] mt-1">
                    Calendar year {statement.year} · Generated for{" "}
                    {publicKey ? shorten(publicKey) : "demo borrower"}
                  </p>
                </div>
                <div className="text-sm text-[var(--text-secondary)] sm:text-right">
                  <p>
                    Loans covered:{" "}
                    <strong className="text-[var(--text-primary)]">
                      {statement.combined.loanCount}
                    </strong>
                  </p>
                  <p>
                    Repayments recorded:{" "}
                    <strong className="text-[var(--text-primary)]">
                      {statement.combined.repaymentCount}
                    </strong>
                  </p>
                </div>
              </div>
            </section>

            {/* Combined annual totals */}
            <section
              aria-labelledby="combined-heading"
              className="statement-section p-6 rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)]"
            >
              <h3 id="combined-heading" className="text-lg font-semibold mb-4">
                Combined Annual Totals
              </h3>
              <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="p-4 rounded-lg bg-[var(--bg-primary)] border border-[var(--border-color)]">
                  <dt className="text-xs uppercase tracking-wider text-[var(--text-muted)]">
                    Principal Paid
                  </dt>
                  <dd className="text-2xl font-bold text-cyan-400 mt-1">
                    {formatAmount(statement.combined.principalPaid)}
                  </dd>
                </div>
                <div className="p-4 rounded-lg bg-[var(--bg-primary)] border border-[var(--border-color)]">
                  <dt className="text-xs uppercase tracking-wider text-[var(--text-muted)]">
                    Interest Paid
                  </dt>
                  <dd className="text-2xl font-bold text-amber-400 mt-1">
                    {formatAmount(statement.combined.interestPaid)}
                  </dd>
                </div>
                <div className="p-4 rounded-lg bg-[var(--bg-primary)] border border-[var(--border-color)]">
                  <dt className="text-xs uppercase tracking-wider text-[var(--text-muted)]">
                    Total Paid
                  </dt>
                  <dd className="text-2xl font-bold text-white mt-1">
                    {formatAmount(statement.combined.totalPaid)}
                  </dd>
                </div>
              </dl>
            </section>

            {/* Per-loan annual totals */}
            <section
              aria-labelledby="per-loan-heading"
              className="statement-section p-6 rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)]"
            >
              <h3 id="per-loan-heading" className="text-lg font-semibold mb-4">
                Per-Loan Annual Totals
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--border-color)] text-[var(--text-muted)] text-xs uppercase tracking-wider">
                      <th className="px-4 py-3 text-left font-medium">Loan</th>
                      <th className="px-4 py-3 text-right font-medium">Principal Paid</th>
                      <th className="px-4 py-3 text-right font-medium">Interest Paid</th>
                      <th className="px-4 py-3 text-right font-medium">Total Paid</th>
                      <th className="px-4 py-3 text-right font-medium">Repayments</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statement.loans.map((loan) => (
                      <tr
                        key={loan.loanId}
                        className="border-b border-[var(--border-color)]/40 last:border-0"
                      >
                        <td className="px-4 py-3">
                          <span className="font-semibold text-white">{loan.loanName}</span>
                          <div className="text-xs text-[var(--text-muted)] font-mono">
                            {loan.loanId}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-cyan-400">
                          {formatAmount(loan.principalPaid)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-amber-400">
                          {formatAmount(loan.interestPaid)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums font-semibold">
                          {formatAmount(loan.totalPaid)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {loan.repaymentCount}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-[var(--border-color)] text-sm">
                      <th scope="row" className="px-4 py-3 text-left font-semibold">
                        Combined
                      </th>
                      <td className="px-4 py-3 text-right tabular-nums font-bold text-cyan-400">
                        {formatAmount(statement.combined.principalPaid)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums font-bold text-amber-400">
                        {formatAmount(statement.combined.interestPaid)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums font-bold">
                        {formatAmount(statement.combined.totalPaid)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums font-bold">
                        {statement.combined.repaymentCount}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>

            {/* Repayment detail */}
            <section
              aria-labelledby="repayments-heading"
              className="statement-section p-6 rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)]"
            >
              <h3 id="repayments-heading" className="text-lg font-semibold mb-4">
                Repayment Detail
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--border-color)] text-[var(--text-muted)] text-xs uppercase tracking-wider">
                      <th className="px-4 py-3 text-left font-medium">Date</th>
                      <th className="px-4 py-3 text-left font-medium">Loan</th>
                      <th className="px-4 py-3 text-right font-medium">Principal</th>
                      <th className="px-4 py-3 text-right font-medium">Interest</th>
                      <th className="px-4 py-3 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statement.repayments.map((repayment) => (
                      <tr
                        key={repayment.id}
                        className="border-b border-[var(--border-color)]/40 last:border-0"
                      >
                        <td className="px-4 py-3 whitespace-nowrap text-[var(--text-secondary)]">
                          {new Date(repayment.date).toLocaleDateString("en-US", {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                            timeZone: "UTC",
                          })}
                        </td>
                        <td className="px-4 py-3 text-[var(--text-secondary)]">
                          {repayment.loanName}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-cyan-400">
                          {formatAmount(repayment.principal)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-amber-400">
                          {formatAmount(repayment.interest)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums font-semibold">
                          {formatAmount(repayment.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

export default function AnnualInterestStatementPage() {
  return (
    <OptionalWalletProvider>
      <AnnualInterestStatementInner />
    </OptionalWalletProvider>
  );
}
