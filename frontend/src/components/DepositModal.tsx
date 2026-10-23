"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, Loader2, AlertCircle, CheckCircle2, WalletMinimal } from "lucide-react";
import { useWallet } from "../context/WalletContext";
import { useTransactionMonitor } from "../hooks/useTransactionMonitor";
import { useFocusTrap } from "../hooks/useFocusTrap";
import {
  buildDepositTx,
  peekCachedEstimate,
  previewTransaction,
  signAndSubmit,
  WalletSignatureError,
  type SimulationEstimate,
} from "../lib/soroban-client";
import {
  SimulationBlockedError,
  type TransactionPreview,
} from "../lib/transaction-preview";
import TransactionPreviewPanel from "./tx/TransactionPreviewPanel";
import {
  formatTransactionErrorMessage,
  type TransactionModalPhase,
} from "../lib/transaction-status";
import TransactionModal from "./tx/TransactionModal";
import ConfirmationDialog from "./ConfirmationDialog";
import GasFeeAdjuster from "./tx/GasFeeAdjuster";
import { useXlmPrice } from "../hooks/useXlmPrice";
import { baselineFeeStroops, feeToUsd, formatFee } from "../lib/gas-fees";
import { WALLET_ERROR_MESSAGES } from "../lib/wallet-errors";
import { track } from "../lib/analytics";

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

/** Stroop amount for a decimal USDC string, used as the cache key discriminator. */
function toStroops(amount: string): string {
  const parsed = parseFloat(amount);
  if (!Number.isFinite(parsed)) return "0";
  return String(Math.round(parsed * 10_000_000));
}

function formatUsdc(amount: string): string {
  const parsed = Number.parseFloat(amount);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : amount;
}

function shortenAddress(address: string): string {
  if (!address) return "connected wallet";
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

export default function DepositModal({ isOpen, onClose }: Props) {
  const { publicKey, usdcBalance, isConnected, wrongNetwork, walletError, connect } =
    useWallet();
  const [amount, setAmount] = useState("");
  const [debouncedAmount, setDebouncedAmount] = useState("");
  const [txXdr, setTxXdr] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<SimulationEstimate | null>(null);
  const [maxFeeStroops, setMaxFeeStroops] = useState<number | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  // Issue #884: what the transaction will actually do, shown before the wallet
  // prompt. `null` means "not simulated yet" — the sign button stays disabled.
  const [preview, setPreview] = useState<TransactionPreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [txPhase, setTxPhase] = useState<TransactionModalPhase>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const [recoveryHint, setRecoveryHint] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const txMonitor = useTransactionMonitor(txHash ?? undefined);
  const xlmPrice = useXlmPrice();
  const dialogRef = useRef<HTMLDivElement>(null);
  const amountInputRef = useRef<HTMLInputElement>(null);
  useFocusTrap(dialogRef, isOpen, { onEscape: onClose, initialFocusRef: amountInputRef });

  const balanceNum = parseFloat(usdcBalance || "0");
  const amountNum = parseFloat(debouncedAmount) || 0;
  const exceedsBalance = amountNum > balanceNum;
  const valid = amountNum > 0 && !exceedsBalance;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedAmount(amount), 500);
    return () => clearTimeout(timer);
  }, [amount]);

  // Seed the fee panel from the session cache so it renders before the fresh
  // simulation lands. Derived during render — no extra state, no extra pass.
  const cachedEstimate = useMemo(() => {
    if (!isOpen || !publicKey || !valid) return null;
    return peekCachedEstimate("deposit", publicKey, [toStroops(debouncedAmount)]);
  }, [isOpen, publicKey, valid, debouncedAmount]);

  const shownEstimate = estimate ?? cachedEstimate;
  const estimateFromCache = estimate === null && cachedEstimate !== null;

  // Rebuild (and re-simulate) whenever the amount or the chosen fee changes.
  useEffect(() => {
    if (!isOpen || !valid || !publicKey) return;

    let active = true;
    setEstimating(true);
    setBuildError(null);
    setPreview(null);
    setAcknowledged(false);

    buildDepositTx(
      publicKey,
      debouncedAmount,
      maxFeeStroops !== null ? { maxFeeStroops: String(maxFeeStroops) } : {}
    )
      .then(async (result) => {
        if (!active) return;
        setTxXdr(result.xdr);
        setEstimate(result.estimate);

        // Simulate and describe before the user can reach the wallet prompt.
        // The intent is what the form says; the preview warns when the
        // envelope disagrees with it.
        const built = await previewTransaction(result.xdr, {
          intent: {
            account: publicKey,
            amount: debouncedAmount,
            asset: "USDC",
            balance: usdcBalance || undefined,
            expectedRecipients: [process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ID || ""].filter(
              Boolean
            ),
          },
          xlmPriceUsd: xlmPrice,
        });
        if (active) setPreview(built);
      })
      .catch((error) => {
        if (!active) return;
        setTxXdr(null);
        setPreview(null);
        setBuildError(formatTransactionErrorMessage(error));
      })
      .finally(() => {
        if (active) setEstimating(false);
      });

    return () => {
      active = false;
    };
  }, [isOpen, debouncedAmount, publicKey, valid, maxFeeStroops, usdcBalance, xlmPrice]);

  useEffect(() => {
    if (txPhase !== "pending" || !txHash) return;

    if (txMonitor.phase === "confirmed") {
      setTxPhase("success");
      track("escrow_deposit_completed");
      return;
    }

    if (txMonitor.phase === "failed") {
      setTxError(txMonitor.contractError || "The transaction reverted on-chain.");
      setCanRetry(true);
      setTxPhase("error");
      return;
    }

    if (txMonitor.pollError) {
      setTxError(txMonitor.pollError);
      setCanRetry(true);
      setTxPhase("error");
    }
  }, [txHash, txMonitor.contractError, txMonitor.phase, txMonitor.pollError, txPhase]);

  // A wallet that disconnects mid-flight must not leave the modal spinning.
  useEffect(() => {
    if (isConnected) return;
    if (txPhase === "signing" || txPhase === "simulating") {
      setTxError(walletError?.message ?? WALLET_ERROR_MESSAGES.disconnected);
      setRecoveryHint("Reconnect your wallet, then retry the deposit.");
      setCanRetry(true);
      setTxPhase("error");
      setSubmitting(false);
    }
  }, [isConnected, txPhase, walletError]);

  const submit = useCallback(async () => {
    if (!valid || !publicKey || !txXdr) return;
    // No preview, a blocked preview, or an unacknowledged warning must never
    // reach the wallet. signAndSubmit enforces this again server-side of the
    // UI, but the button should not have been reachable either.
    if (!preview?.ok) return;
    if (preview.requiresAcknowledgement && !acknowledged) return;
    const xdr = txXdr;

    setSubmitting(true);
    setTxError(null);
    setRecoveryHint(null);
    setCanRetry(false);
    setTxHash(null);
    setTxPhase("signing");

    try {
      const hash = await signAndSubmit(xdr, { preview });
      setTxHash(hash);
      setTxPhase("pending");
    } catch (error) {
      if (error instanceof SimulationBlockedError) {
        // The transaction became unsignable between preview and submit (a
        // changed ledger state, a stale envelope). Nothing was signed.
        setPreview(error.preview);
        setTxError(error.message);
        setRecoveryHint("Nothing was signed and no fee was charged. Adjust the amount and retry.");
        setCanRetry(true);
        setTxPhase("error");
      } else if (error instanceof WalletSignatureError) {
        setTxError(error.wallet.message);
        setRecoveryHint(
          error.wallet.kind === "rejected"
            ? "Nothing was submitted. Approve the request in Freighter to continue."
            : error.wallet.detail ?? null
        );
        // Rejections and recoverable wallet states can both be retried; a
        // missing extension cannot.
        setCanRetry(error.wallet.kind !== "not_installed");
      } else {
        setTxError(formatTransactionErrorMessage(error));
        setCanRetry(true);
      }
      setTxPhase("error");
    } finally {
      setSubmitting(false);
    }
  }, [acknowledged, preview, publicKey, txXdr, valid]);

  function resetTransactionState() {
    setTxPhase("idle");
    setTxHash(null);
    setTxError(null);
    setRecoveryHint(null);
    setCanRetry(false);
  }

  function handleTransactionModalClose() {
    const wasSuccessful = txPhase === "success";
    resetTransactionState();

    if (wasSuccessful) {
      setAmount("");
      setDebouncedAmount("");
      setTxXdr(null);
      setPreview(null);
      setAcknowledged(false);
      setMaxFeeStroops(null);
      onClose();
    }
  }

  const usableXdr = valid && publicKey ? txXdr : null;

  const feeSummary = useMemo(() => {
    const stroops = maxFeeStroops ?? baselineFeeStroops(shownEstimate);
    return {
      label: formatFee(stroops),
      usd: feeToUsd(stroops, xlmPrice),
    };
  }, [shownEstimate, maxFeeStroops, xlmPrice]);

  if (!isOpen) return null;

  const walletBlocked = !isConnected || wrongNetwork;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="deposit-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
    >
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative w-full max-w-md bg-[var(--bg-card)] border border-[var(--border-color)] shadow-2xl rounded-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between p-5 border-b border-[var(--border-color)]">
          <h2 id="deposit-modal-title" className="text-lg font-bold text-[var(--text-primary)]">Deposit USDC</h2>
          <button
            onClick={onClose}
            aria-label="Close deposit dialog"
            className="p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {!isConnected && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-[var(--text-secondary)]"
            >
              <span className="flex items-center gap-2">
                <WalletMinimal className="h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
                {walletError?.message ?? WALLET_ERROR_MESSAGES.disconnected}
              </span>
              <button onClick={() => connect()} className="btn-outline !py-1.5 !px-3 !text-xs">
                Connect Wallet
              </button>
            </div>
          )}

          {wrongNetwork && (
            <div
              role="alert"
              className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300"
            >
              {WALLET_ERROR_MESSAGES.network_mismatch}
            </div>
          )}

          <div>
            <label
              htmlFor="deposit-amount"
              className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5"
            >
              Amount (USDC)
            </label>
            <div className="relative">
              <input
                ref={amountInputRef}
                id="deposit-amount"
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
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

          <GasFeeAdjuster
            estimate={shownEstimate}
            value={maxFeeStroops}
            onChange={setMaxFeeStroops}
            xlmPriceUsd={xlmPrice}
            loading={estimating}
            disabled={submitting}
            fromCache={estimateFromCache}
          />

          {buildError && (
            <p role="alert" className="text-xs text-[var(--error)]">
              {buildError}
            </p>
          )}

          {valid && !buildError && (
            <TransactionPreviewPanel
              preview={preview}
              loading={estimating}
              acknowledged={acknowledged}
              onAcknowledgedChange={setAcknowledged}
            />
          )}

          <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
            <span>Max network fee</span>
            <span className="font-mono text-[var(--text-secondary)]">
              {feeSummary.label}
              {feeSummary.usd ? ` · ~$${feeSummary.usd}` : ""}
            </span>
          </div>

          <button
            onClick={() => setShowConfirmation(true)}
            disabled={
              !valid ||
              estimating ||
              !usableXdr ||
              submitting ||
              walletBlocked ||
              // Issue #884: not simulated, simulation failed, or a danger
              // warning the user has not acknowledged.
              !preview?.ok ||
              (preview.requiresAcknowledgement && !acknowledged)
            }
            className="w-full btn-primary justify-center disabled:opacity-40"
          >
            {submitting || estimating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <CheckCircle2 className="w-4 h-4" />
            )}
            {estimating ? "Simulating…" : "Confirm & Sign"}
          </button>
        </div>
      </div>

      <ConfirmationDialog
        isOpen={showConfirmation}
        title="Confirm USDC deposit"
        description={`Deposit ${formatUsdc(debouncedAmount)} USDC into the escrow contract from ${shortenAddress(publicKey ?? "")}. This financial transaction cannot be reversed after confirmation.`}
        confirmationText="DEPOSIT"
        confirmLabel="Confirm and sign"
        onConfirm={submit}
        onCancel={() => setShowConfirmation(false)}
      />

      <TransactionModal
        isOpen={txPhase !== "idle"}
        phase={txPhase}
        transactionType="Deposit"
        hash={txHash}
        errorMessage={txError}
        recoveryHint={recoveryHint}
        onRetry={canRetry ? submit : undefined}
        retrying={submitting}
        onClose={handleTransactionModalClose}
      />
    </div>
  );
}
