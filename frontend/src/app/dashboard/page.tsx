"use client"

export const dynamic = "force-dynamic";

import React, { useEffect, useState } from "react";
import loadDynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { WalletProvider, useWallet } from "../../context/WalletContext";
import SavingsProgressCard from "../../components/SavingsProgressCard";
import LoanStatusCard from "../../components/LoanStatusCard";
import DepositModal from "../../components/DepositModal";
import WithdrawModal from "../../components/WithdrawModal";
import {
  consumeTxSuccessFeedback,
  shortenAddress,
  STELLARCHAIN_TX_BASE,
} from "../../lib/transaction-status";

const Navbar = loadDynamic(() => import("../../components/Navbar"), { ssr: false });

type BorrowerStatus = {
  address: string;
  escrow: { deposited: string; target: string; progress: number };
  loan: { status: string; principal: string; disbursed: string; repaid: string };
};

function DashboardInner() {
  const router = useRouter();
  const { publicKey, isConnected } = useWallet();
  const [status, setStatus] = useState<BorrowerStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txSuccess, setTxSuccess] = useState<{ hash: string; type: string } | null>(null);
  const [showDeposit, setShowDeposit] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);

  useEffect(() => {
    const feedback = consumeTxSuccessFeedback();
    if (feedback) {
      setTxSuccess(feedback);
    }
  }, []);

  useEffect(() => {
    if (!isConnected) {
      router.push("/");
      return;
    }

    if (!publicKey) return;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/borrower/${publicKey}/status`);
        if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
        const data = await res.json();
        setStatus(data);
      } catch (e: any) {
        setError(e?.message || "Failed to load borrower status");
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [isConnected, publicKey, router]);

  return (
    <div>
      <Navbar />
      <main className="max-w-4xl mx-auto px-6 py-24">
        <h1 className="text-3xl font-bold mb-6">Borrower Dashboard</h1>

        {txSuccess && (
          <div
            role="status"
            className="mb-6 p-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
          >
            <div>
              <p className="text-sm font-semibold text-emerald-400">
                {txSuccess.type} confirmed successfully
              </p>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                Transaction {shortenAddress(txSuccess.hash)} is on-chain.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <a
                href={`${STELLARCHAIN_TX_BASE}${txSuccess.hash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-[var(--accent-primary-light)] hover:underline"
              >
                View on explorer
              </a>
              <button
                type="button"
                onClick={() => setTxSuccess(null)}
                className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {loading && <div className="p-6 bg-[var(--bg-card)] rounded-md">Loading...</div>}
        {error && <div className="p-6 bg-red-50 text-red-700 rounded-md">{error}</div>}

        {!loading && !error && status && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <SavingsProgressCard
              deposited={status.escrow.deposited}
              target={status.escrow.target}
              progress={status.escrow.progress}
            />
            <div className="space-y-6">
              <LoanStatusCard loan={status.loan} />
              <div className="flex flex-col gap-3 p-6 bg-[var(--bg-card)] rounded-md">
                <h3 className="text-lg font-semibold mb-2">Deposit USDC</h3>
                <button
                  onClick={() => setShowDeposit(true)}
                  className="btn-primary justify-center"
                >
                  Open Deposit
                </button>
                <button
                  onClick={() => setShowWithdraw(true)}
                  className="btn-outline justify-center"
                >
                  Early Withdrawal
                </button>
              </div>
            </div>
          </div>
        )}

        <DepositModal isOpen={showDeposit} onClose={() => setShowDeposit(false)} />
        <WithdrawModal
          isOpen={showWithdraw}
          onClose={() => setShowWithdraw(false)}
          deposited={status?.escrow.deposited || "0"}
        />

        {!loading && !error && !status && (
          <div className="p-6 bg-[var(--bg-card)] rounded-md">No borrower data available.</div>
        )}
      </main>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <WalletProvider>
      <DashboardInner />
    </WalletProvider>
  );
}
