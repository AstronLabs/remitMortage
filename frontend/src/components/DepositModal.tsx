"use client"

import React, { useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import { X, Loader2, ArrowRight, AlertCircle, CheckCircle2 } from "lucide-react";
import { useWallet } from "../context/WalletContext";
import { useTransactionMonitor } from "../hooks/useTransactionMonitor";
import { buildDepositTx, signAndSubmit } from "../lib/soroban";
import {
  formatTransactionErrorMessage,
  type TransactionModalPhase,
} from "../lib/transaction-status";
import TransactionModal from "./tx/TransactionModal";

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

export default function DepositModal({ isOpen, onClose }: Props) {
  const { publicKey, usdcBalance } = useWallet();
  const [amount, setAmount] = useState("");
  const [estimating, setEstimating] = useState(false);
  const [estimatedFee, setEstimatedFee] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [txPhase, setTxPhase] = useState<TransactionModalPhase>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const txMonitor = useTransactionMonitor(txHash ?? undefined);

  function resetTransactionState() {
    setTxPhase("idle");
    setTxHash(null);
    setTxError(null);
  }

  function handleTransactionModalClose() {
    const wasSuccessful = txPhase === "success";
    resetTransactionState();

    if (wasSuccessful) {
      setAmount("");
      setEstimatedFee(null);
      onClose();
    }
  }

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

  const balanceNum = parseFloat(usdcBalance || "0");
  const amountNum = parseFloat(amount) || 0;
  const exceedsBalance = amountNum > balanceNum;
  const valid = amountNum > 0 && !exceedsBalance;

  async function handleEstimate() {
    if (!valid || !publicKey) return;
    setEstimating(true);
    try {
      const txXdr = await buildDepositTx(publicKey, amount);
      setEstimatedFee(`${((txXdr.length / 1024) * 0.00001).toFixed(7)} XLM (estimated)`);
    } catch (e: any) {
      toast.error(e?.message || "Estimation failed");
    } finally {
      setEstimating(false);
    }
  }

  async function handleConfirm() {
    if (!valid || !publicKey) return;
    setSubmitting(true);
    setTxError(null);
    setTxHash(null);
    setTxPhase("simulating");
    try {
      const txXdr = await buildDepositTx(publicKey, amount);
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
          <h2 className="text-lg font-bold text-[var(--text-primary)]">Deposit USDC</h2>
          <button onClick={onClose} className="p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">
              Amount (USDC)
            </label>
            <div className="relative">
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setEstimatedFee(null);
                }}
                className="w-full p-3 pr-20 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-lg font-mono outline-none focus:border-[var(--accent-primary)] transition-colors"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[var(--text-muted)]">
                USDC
              </span>
            </div>
            <div className="flex justify-between mt-1.5">
              <span className="text-xs text-[var(--text-muted)]">
                Balance: {usdcBalance || "—"} USDC
              </span>
              {exceedsBalance && (
                <span className="text-xs text-[var(--error)] flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" /> Insufficient balance
                </span>
              )}
            </div>
          </div>

          {estimatedFee && (
            <div className="p-3 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)]">
              <div className="flex items-center gap-2 text-sm">
                <ArrowRight className="w-4 h-4 text-[var(--accent-primary)]" />
                <span className="text-[var(--text-secondary)]">Estimated fee:</span>
                <span className="text-[var(--text-primary)] font-mono">{estimatedFee}</span>
              </div>
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={handleEstimate}
              disabled={!valid || estimating}
              className="flex-1 btn-outline justify-center disabled:opacity-40"
            >
              {estimating ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Estimate Fee
            </button>
            <button
              onClick={handleConfirm}
              disabled={!valid || submitting}
              className="flex-1 btn-primary justify-center disabled:opacity-40"
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <CheckCircle2 className="w-4 h-4" />
              )}
              Confirm & Sign
            </button>
          </div>
        </div>
      </div>

      <TransactionModal
        isOpen={txPhase !== "idle"}
        phase={txPhase}
        transactionType="Deposit"
        hash={txHash}
        errorMessage={txError}
        onClose={handleTransactionModalClose}
      />
    </div>
  );
}
