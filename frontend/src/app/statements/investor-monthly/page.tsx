"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

export const dynamic = "force-dynamic";

import React, { useEffect, useMemo, useState } from "react";
import dynamicImport from "next/dynamic";
import { OptionalWalletProvider, useWallet } from "@/context/WalletContext";
import InvestorMonthlyStatements from "@/components/InvestorMonthlyStatements";
import { parseTokenAmount } from "@/lib/annualInterestStatement";
import {
  buildMonthlyInvestorStatementPayload,
  monthlyStatementFilename,
  type InvestorTransaction,
  type MonthlyInvestorStatement,
} from "@/lib/monthlyInvestorStatement";
import { createStatementMetadata, downloadStatementPdf } from "@/lib/statementExport";
import type {
  InvestorTransactionRecord,
  InvestorTransactionsResponse,
} from "@/app/api/investor/[publicKey]/transactions/route";

const Navbar = dynamicImport(() => import("@/components/Navbar"), { ssr: false });

function shorten(address: string) {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function toInvestorTransaction(record: InvestorTransactionRecord): InvestorTransaction {
  return {
    id: record.id,
    type: record.type,
    date: record.date,
    amount: parseTokenAmount(record.amount),
    txHash: record.txHash,
  };
}

function InvestorMonthlyStatementsInner() {
  const { publicKey } = useWallet();
  const [transactions, setTransactions] = useState<InvestorTransaction[]>([]);
  const [accountOpenedAt, setAccountOpenedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const address = publicKey ?? "demo-investor";
        const res = await fetch(`/api/investor/${encodeURIComponent(address)}/transactions`);
        if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
        const data = (await res.json()) as Partial<InvestorTransactionsResponse>;
        if (cancelled) return;
        setTransactions(
          Array.isArray(data.transactions) ? data.transactions.map(toInvestorTransaction) : []
        );
        setAccountOpenedAt(typeof data.accountOpenedAt === "string" ? data.accountOpenedAt : null);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load investor transactions");
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

  const metadata = useMemo(
    () =>
      createStatementMetadata({
        borrowerName: publicKey ? `Investor ${shorten(publicKey)}` : "Investor (demo wallet)",
        borrowerAddress: publicKey ?? "STELLAR-PUBLIC-KEY-NOT-CONNECTED",
        walletType: "Freighter / Stellar",
      }),
    [publicKey]
  );

  function handleDownload(statement: MonthlyInvestorStatement) {
    downloadStatementPdf(
      buildMonthlyInvestorStatementPayload(statement, metadata),
      monthlyStatementFilename(statement.month)
    );
  }

  return (
    <div className="rm-app-page min-h-screen bg-[#060913] text-slate-100 pb-20">
      <Navbar />

      <main className="max-w-7xl mx-auto px-6 pt-32 pb-20">
        <div className="mb-8">
          <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-cyan-500/10 text-cyan-400 text-xs font-semibold uppercase tracking-wider mb-3 border border-cyan-500/20">
            Investor Records
          </span>
          <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight text-white mb-2">
            Monthly <span className="gradient-text">Investor Statements</span>
          </h1>
          <p className="text-slate-400 text-sm md:text-base max-w-2xl">
            One statement per month since your account opened, summarizing deposits, withdrawals,
            yield earned and your closing balance. Download a PDF for your records or your
            accountant.
          </p>
        </div>

        {loading && (
          <div className="p-6 bg-[var(--bg-card)] rounded-lg text-sm text-[var(--text-muted)]">
            Loading statements{"…"}
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

        {!loading && !error && accountOpenedAt && (
          <InvestorMonthlyStatements
            transactions={transactions}
            accountOpenedAt={accountOpenedAt}
            onDownload={handleDownload}
          />
        )}
      </main>
    </div>
  );
}

export default function InvestorMonthlyStatementsPage() {
  return (
    <OptionalWalletProvider>
      <InvestorMonthlyStatementsInner />
    </OptionalWalletProvider>
  );
}
