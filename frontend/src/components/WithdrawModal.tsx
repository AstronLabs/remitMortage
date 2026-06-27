"use client"

import React, { useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import { X, Loader2, AlertTriangle, ArrowRight, CheckCircle2 } from "lucide-react";
import { useWallet } from "../context/WalletContext";
import { useTransactionMonitor } from "../hooks/useTransactionMonitor";
import { buildWithdrawTx, signAndSubmit, queryEscrowConfig } from "../lib/soroban";
import {
  formatTransactionErrorMessage,
  type TransactionModalPhase,
} from "../lib/transaction-status";
import TransactionModal from "./tx/TransactionModal";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  deposited: string;
};

export default function WithdrawModal({ isOpen, onClose, deposited }: Props) {
  const { publicKey } = useWallet();
  const [penaltyBps, setPenaltyBps] = useState<number | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [txPhase, setTxPhase] = useState<TransactionModalPhase>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const txMonitor = useTransactionMonitor(txHash ?? undefined);

  const depositNum = parseFloat(deposited) || 0;
  const penaltyPct = penaltyBps !== null ? penaltyBps / 100 : null;
  const penaltyAmount = penaltyPct !== null && penaltyPct !== null ? (depositNum * penaltyPct) / 100 : null;
  const refundAmount = penaltyAmount !== null ? depositNum - penaltyAmount : null;

  function resetTransactionState() {
    setTxPhase("idle");
    setTxHash(null);
    setTxError(null);
  }

  useEffect(() => {
    if (!isOpen || !publicKey) return;
    const accountId = publicKey;
    setConfirmed(false);
    setSubmitting(false);

    async function load() {
      setLoadingConfig(true);
      try {
        const config = await queryEscrowConfig(accountId);
        setPenaltyBps(config.earlyWithdrawalPenaltyBps);
      } catch (e: any) {
        toast.error(e?.message || "Failed to fetch contract config");
        setPenaltyBps(500);
      } finally {
        setLoadingConfig(false);
      }
    }
    load();
  }, [isOpen, publicKey]);

  useEffect(() => {
    if (txPhase !== "pending" || !txHash) return;

    if (txMonitor.phase === "confirmed") {
      setTxPhase("success");
      return;
    }

    if (txMonitor.phase === "failed") {
      setTxError(txMonitor.contractError || "The transaction reverted on-chain.");
      setTxPhase("error");
      return;
    }

    if (txMonitor.pollError) {
      setTxError(txMonitor.pollError);
      setTxPhase("error");
    }
  }, [
    txHash,
    txMonitor.contractError,
    txMonitor.phase,
    txMonitor.pollError,
    txPhase,
  ]);

  if (!isOpen) return null;

  function handleTransactionModalClose() {
    const wasSuccessful = txPhase === "success";
    resetTransactionState();

    if (wasSuccessful) {
      setConfirmed(false);
      onClose();
    }
  }

  async function handleWithdraw() {
    if (!publicKey || !confirmed) return;
    setSubmitting(true);
    setTxError(null);
    setTxHash(null);
    setTxPhase("simulating");
    try {
      const txXdr = await buildWithdrawTx(publicKey);
      setTxPhase("signing");
      const hash = await signAndSubmit(txXdr);
      setTxHash(hash);
      setTxPhase("pending");
    } catch (error) {
      setTxError(formatTransactionErrorMessage(error));
      setTxPhase("error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-md bg-[var(--bg-card)] border border-[var(--border-color)] shadow-2xl rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between p-5 border-b border-[var(--border-color)]">
          <h2 className="text-lg font-bold text-[var(--text-primary)]">Early Withdrawal</h2>
          <button onClick={onClose} className="p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {loadingConfig ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-[var(--accent-primary)]" />
              <span className="ml-3 text-sm text-[var(--text-secondary)]">Loading contract config...</span>
            </div>
          ) : (
            <>
              <div className="space-y-3 p-4 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)]">
                <div className="flex justify-between text-sm">
                  <span className="text-[var(--text-secondary)]">Deposited amount</span>
                  <span className="text-[var(--text-primary)] font-mono">{depositNum.toLocaleString()} USDC</span>
                </div>
                {penaltyPct !== null && (
                  <div className="flex justify-between text-sm">
                    <span className="text-[var(--text-secondary)]">Early exit penalty</span>
                    <span className="text-[var(--warning)] font-mono">{penaltyPct}% ({penaltyBps} bps)</span>
                  </div>
                )}
                {penaltyAmount !== null && (
                  <div className="flex justify-between text-sm">
                    <span className="text-[var(--text-secondary)]">Penalty amount</span>
                    <span className="text-[var(--error)] font-mono">-{penaltyAmount.toLocaleString()} USDC</span>
                  </div>
                )}
                {refundAmount !== null && (
                  <div className="flex justify-between text-sm pt-2 border-t border-[var(--border-color)]">
                    <span className="text-[var(--text-secondary)] font-semibold">Estimated refund</span>
                    <span className="text-[var(--success)] font-mono font-bold">{refundAmount.toLocaleString()} USDC</span>
                  </div>
                )}
              </div>

              <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-[var(--warning)] shrink-0 mt-0.5" />
                  <div className="text-sm text-[var(--text-secondary)]">
                    Early withdrawal applies a penalty of <strong className="text-[var(--text-primary)]">{penaltyPct}%</strong> of your deposited amount. This action cannot be undone.
                  </div>
                </div>
              </div>

              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  className="mt-1 w-4 h-4 rounded border-[var(--border-color)] accent-[var(--accent-primary)]"
                />
                <span className="text-sm text-[var(--text-secondary)]">
                  I understand the penalty and want to proceed with early withdrawal.
                </span>
              </label>

              <button
                onClick={handleWithdraw}
                disabled={!confirmed || submitting}
                className="w-full btn-primary justify-center disabled:opacity-40"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-4 h-4" />
                )}
                {submitting ? "Processing..." : "Confirm & Sign Withdrawal"}
              </button>
            </>
          )}
        </div>
      </div>

      <TransactionModal
        isOpen={txPhase !== "idle"}
        phase={txPhase}
        transactionType="Withdrawal"
        hash={txHash}
        errorMessage={txError}
        onClose={handleTransactionModalClose}
      />
    </div>
  );
}
