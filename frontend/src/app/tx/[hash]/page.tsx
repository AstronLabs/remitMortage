"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { Suspense, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useTransactionMonitor } from "../../../hooks/useTransactionMonitor";
import { parseTransactionType, storeTxSuccessFeedback } from "../../../lib/transaction-status";
import TransactionDetails from "../../../components/tx/TransactionDetails";
import TransactionProgress from "../../../components/tx/TransactionProgress";
import TransactionResult from "../../../components/tx/TransactionResult";

const Navbar = dynamic(() => import("../../../components/Navbar"), { ssr: false });

function TxStatusContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const hash = typeof params?.hash === "string" ? params.hash : "";
  const txType = parseTransactionType(searchParams?.get("type") ?? null);
  const senderOverride = searchParams?.get("from") ?? null;

  const monitor = useTransactionMonitor(hash);

  const handleReturnToDashboard = useCallback(() => {
    storeTxSuccessFeedback(hash, txType);
    router.push("/dashboard");
  }, [hash, router, txType]);

  useEffect(() => {
    if (monitor.phase !== "confirmed") return;

    const timer = setTimeout(() => {
      storeTxSuccessFeedback(hash, txType);
      router.push("/dashboard");
    }, 5000);

    return () => clearTimeout(timer);
  }, [hash, monitor.phase, router, txType]);

  if (!hash) {
    return (
      <div className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-10 text-center">
        <p className="text-[var(--text-secondary)]">Invalid transaction hash.</p>
      </div>
    );
  }

  const isTerminal = monitor.phase === "confirmed" || monitor.phase === "failed";

  return (
    <>
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-1">Transaction Status</h1>
        <p className="text-[var(--text-secondary)] text-sm">
          Tracking {txType.toLowerCase()} on Soroban testnet
        </p>
      </div>

      {monitor.pollError && (
        <div
          role="alert"
          className="mb-6 bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-400 text-sm"
        >
          {monitor.pollError}
        </div>
      )}

      <TransactionProgress phase={monitor.phase} isPolling={monitor.isPolling} />

      {isTerminal ? (
        <div className="mb-6">
          <TransactionResult
            hash={hash}
            success={monitor.phase === "confirmed"}
            contractError={monitor.contractError}
            onReturnToDashboard={
              monitor.phase === "confirmed" ? handleReturnToDashboard : undefined
            }
          />
          {monitor.phase === "confirmed" && (
            <p className="text-center text-xs text-[var(--text-muted)] mt-3">
              Redirecting to dashboard in a few seconds…
            </p>
          )}
        </div>
      ) : (
        <div className="mb-6 bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-8 text-center">
          <div className="inline-block w-8 h-8 border-2 border-[var(--accent-primary)] border-t-transparent rounded-full animate-spin mb-4" />
          <p className="text-sm text-[var(--text-secondary)]">Waiting for on-chain confirmation…</p>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Polling Soroban RPC every 2 seconds (attempt {monitor.pollCount || 1})
          </p>
        </div>
      )}

      <TransactionDetails
        hash={hash}
        type={txType}
        senderAddress={monitor.senderAddress}
        senderOverride={senderOverride}
        gasFee={monitor.gasFee}
        logs={monitor.logs}
      />
    </>
  );
}

function TxStatusFallback() {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-10 text-center">
      <div className="inline-block w-6 h-6 border-2 border-[var(--accent-primary)] border-t-transparent rounded-full animate-spin mb-3" />
      <p className="text-sm text-[var(--text-secondary)]">Loading transaction status…</p>
    </div>
  );
}

export default function TxStatusPage() {
  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      <Navbar />
      <main className="max-w-3xl mx-auto px-6 py-24">
        <Suspense fallback={<TxStatusFallback />}>
          <TxStatusContent />
        </Suspense>
      </main>
    </div>
  );
}
