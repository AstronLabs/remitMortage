"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import toast, { Toaster } from "react-hot-toast";
import { useWallet, OptionalWalletProvider } from "@/context/WalletContext";
import { isValidStellarAddress, VerificationResult, VerificationStats } from "@/lib/verification";

const Navbar = dynamic(() => import("@/components/Navbar"), { ssr: false });

export default function VerifyPage() {
  return (
    <OptionalWalletProvider>
      <VerifyPageInner />
    </OptionalWalletProvider>
  );
}

function VerifyPageInner() {
  const t = useTranslations("verify");
  const { publicKey } = useWallet();

  const [senderAddress, setSenderAddress] = useState("");
  const [recipientAddress, setRecipientAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<VerificationResult | null>(null);

  useEffect(() => {
    if (publicKey && senderAddress === "") {
      setSenderAddress(publicKey);
    }
  }, [publicKey, senderAddress]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!isValidStellarAddress(senderAddress)) {
      toast.error(t("toastInvalidSender"));
      return;
    }
    if (!isValidStellarAddress(recipientAddress)) {
      toast.error(t("toastInvalidRecipient"));
      return;
    }
    if (senderAddress === recipientAddress) {
      toast.error(t("toastDifferent"));
      return;
    }

    setLoading(true);
    setResult(null);
    try {
      const response = await fetch("/api/verification/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderAddress, recipientAddress }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error ?? "Verification failed.");
      }
      setResult(data as VerificationResult);
      toast.success(t("toastSuccess"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Verification failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="rm-app-page rm-verify-page min-h-screen bg-[#060913] text-slate-100 pb-20 relative">
      <Navbar />
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: "#0f172a",
            color: "#f8fafc",
            border: "1px solid rgba(255,255,255,0.1)",
            boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
          },
        }}
      />

      <div className="rm-verify-content max-w-4xl mx-auto px-4 md:px-6 pt-32 pb-20 relative z-10">
        {/* Header */}
        <div className="mb-10 text-center md:text-left">
          <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-cyan-500/10 text-cyan-400 text-xs font-semibold uppercase tracking-wider mb-4 border border-cyan-500/20">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
            {t("eyebrow")}
          </span>
          <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight text-white mb-3">
            {t("title")}
          </h1>
          <p className="text-slate-400 max-w-2xl text-sm md:text-base leading-relaxed">
            {t("description")}
          </p>
        </div>

        {/* Verification Form Card */}
        <div className="p-6 md:p-8 bg-slate-900/80 border border-slate-800 rounded-2xl backdrop-blur-xl mb-8 relative overflow-hidden shadow-xl">
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Sender Wallet Address */}
              <div>
                <label
                  htmlFor="sender-address"
                  className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-2"
                >
                  {t("senderLabel")}
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-500">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
                      />
                    </svg>
                  </div>
                  <input
                    id="sender-address"
                    type="text"
                    spellCheck={false}
                    placeholder="Enter Stellar address starting with G..."
                    value={senderAddress}
                    onChange={(event) => setSenderAddress(event.target.value.trim())}
                    className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-700 bg-slate-950/60 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 font-mono transition-all duration-200"
                  />
                </div>
                {publicKey && senderAddress === publicKey ? (
                  <p className="text-[11px] text-emerald-400 font-medium mt-2 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Loaded from connected Freighter wallet.
                  </p>
                ) : (
                  <p className="text-[11px] text-slate-500 mt-2">
                    {t("senderHint")}
                  </p>
                )}
              </div>

              {/* Recipient Address */}
              <div>
                <label
                  htmlFor="recipient-address"
                  className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-2"
                >
                  {t("recipientLabel")}
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-500">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
                      />
                    </svg>
                  </div>
                  <input
                    id="recipient-address"
                    type="text"
                    spellCheck={false}
                    placeholder="Enter Stellar address starting with G..."
                    value={recipientAddress}
                    onChange={(event) => {
                      setResult(null);
                      setRecipientAddress(event.target.value.trim());
                    }}
                    className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-700 bg-slate-950/60 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 font-mono transition-all duration-200"
                  />
                </div>
                <p className="text-[11px] text-slate-500 mt-2">
                  {t("recipientHint")}
                </p>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="btn-cta w-full justify-center py-3.5 shadow-lg shadow-cyan-500/20"
              aria-busy={loading}
            >
              {loading ? (
                <span className="flex items-center gap-2 text-slate-950">
                  <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  {t("loading")}
                </span>
              ) : (
                <>
                  {t("submit")}
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 12h14" />
                    <path d="m12 5 7 7-7 7" />
                  </svg>
                </>
              )}
            </button>
          </form>
        </div>

        {/* Output Cards */}
        <div className="transition-all duration-500">
          {loading && <ResultsSkeleton />}

          {!loading && result && <Results result={result} />}

          {!loading && !result && (
            <div className="p-10 bg-slate-900/50 text-center text-slate-400 border border-slate-800 rounded-2xl flex flex-col items-center justify-center">
              <svg
                className="w-12 h-12 text-slate-600 mb-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <p className="text-sm">
                {t("emptyState")}
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function ResultsSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-hidden="true">
      <div className="h-24 rounded-2xl bg-slate-900 border border-slate-800" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="h-28 rounded-2xl bg-slate-900 border border-slate-800" />
        ))}
      </div>
      <div className="h-36 rounded-2xl bg-slate-900 border border-slate-800" />
    </div>
  );
}

function Results({ result }: { result: VerificationResult }) {
  return (
    <div className="space-y-6 animate-fade-in-up">
      <EligibilityBadge eligible={result.eligible} message={result.message} />
      <StatsGrid stats={result.stats} />
      <Timeline stats={result.stats} />
    </div>
  );
}

function EligibilityBadge({ eligible, message }: { eligible: boolean; message: string }) {
  return (
    <div
      role="status"
      className={`flex items-start gap-4 p-6 rounded-2xl border backdrop-blur-xl transition-all duration-300 ${
        eligible
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
          : "border-amber-500/30 bg-amber-500/10 text-amber-300"
      }`}
    >
      <span
        className={`shrink-0 inline-flex items-center justify-center w-12 h-12 rounded-xl text-slate-950 font-extrabold text-xl shadow-lg ${
          eligible ? "bg-emerald-400 shadow-emerald-500/20" : "bg-amber-400 shadow-amber-500/20"
        }`}
        aria-hidden="true"
      >
        {eligible ? "✓" : "✕"}
      </span>
      <div>
        <h3 className="text-xl font-bold text-white mb-1">
          {eligible ? "Verification Passed • Qualified for Escrow" : "Verification Incomplete"}
        </h3>
        <p className="text-xs text-slate-300 leading-relaxed">{message}</p>
      </div>
    </div>
  );
}

function StatsGrid({ stats }: { stats: VerificationStats }) {
  const cards = [
    {
      label: "Payments Logged",
      value: stats.totalPayments.toLocaleString(),
      color: "text-cyan-400",
    },
    {
      label: "Total USDC Volume",
      value: `$${stats.totalVolume.toLocaleString()}`,
      color: "text-emerald-400",
    },
    {
      label: "Avg Payment Size",
      value: `$${stats.averagePayment.toLocaleString()}`,
      color: "text-indigo-400",
    },
    {
      label: "Timespan Checked",
      value: `${stats.timespanMonths} Months`,
      color: "text-purple-400",
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {cards.map((card) => (
        <div
          key={card.label}
          className="p-5 bg-slate-900/70 rounded-2xl border border-slate-800 flex flex-col justify-between"
        >
          <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider">
            {card.label}
          </span>
          <span className={`text-2xl font-extrabold mt-3 ${card.color} font-mono`}>
            {card.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function Timeline({ stats }: { stats: VerificationStats }) {
  if (!stats.firstPaymentDate || !stats.lastPaymentDate) {
    return null;
  }
  return (
    <div className="p-6 bg-slate-900/80 border border-slate-800 rounded-2xl shadow-xl">
      <h3 className="text-xs font-bold text-slate-400 tracking-wider uppercase mb-5">
        Horizon Ledger Payment Timeline
      </h3>
      <div className="flex items-center gap-4">
        <div className="text-left shrink-0">
          <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider block mb-0.5">
            First Recorded
          </span>
          <span className="text-xs font-bold text-white font-mono">
            {formatDate(stats.firstPaymentDate)}
          </span>
        </div>
        <div className="flex-1 relative h-3 rounded-full bg-slate-950 border border-slate-800 overflow-hidden flex items-center">
          <span className="absolute inset-0 rounded-full bg-gradient-to-r from-cyan-400 via-indigo-500 to-emerald-400" />
        </div>
        <div className="text-right shrink-0">
          <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider block mb-0.5">
            Latest Recorded
          </span>
          <span className="text-xs font-bold text-white font-mono">
            {formatDate(stats.lastPaymentDate)}
          </span>
        </div>
      </div>
      <p className="text-[11px] text-slate-400 mt-4 text-center">
        Audited <span className="text-cyan-400 font-bold">{stats.timespanMonths} months</span> of
        historical payment consistency.
      </p>
    </div>
  );
}
