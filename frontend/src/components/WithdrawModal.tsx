"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "react-hot-toast";
import {
  X,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  WalletMinimal,
} from "lucide-react";
import { useWallet } from "../context/WalletContext";
import { useTransactionMonitor } from "../hooks/useTransactionMonitor";
import {
  buildWithdrawTx,
  peekCachedEstimate,
  queryEscrowConfig,
  signAndSubmit,
  WalletSignatureError,
  type SimulationEstimate,
} from "../lib/soroban-client";
import {
  formatTransactionErrorMessage,
  type TransactionModalPhase,
} from "../lib/transaction-status";
import TransactionModal from "./tx/TransactionModal";
import GasFeeAdjuster from "./tx/GasFeeAdjuster";
import { useXlmPrice } from "../hooks/useXlmPrice";
import { baselineFeeStroops, feeToUsd, formatFee } from "../lib/gas-fees";
import { WALLET_ERROR_MESSAGES } from "../lib/wallet-errors";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  deposited: string;
};

export default function WithdrawModal({ isOpen, onClose, deposited }: Props) {
  const { publicKey, isConnected, wrongNetwork, walletError, connect } = useWallet();
  const [penaltyBps, setPenaltyBps] = useState<number | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [txPhase, setTxPhase] = useState<TransactionModalPhase>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const [recoveryHint, setRecoveryHint] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [txXdr, setTxXdr] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<SimulationEstimate | null>(null);
  const [maxFeeStroops, setMaxFeeStroops] = useState<number | null>(null);
  const [estimatingTx, setEstimatingTx] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const txMonitor = useTransactionMonitor(txHash ?? undefined);
  const xlmPrice = useXlmPrice();

  const depositNum = parseFloat(deposited) || 0;
  const penaltyPct = penaltyBps !== null ? penaltyBps / 100 : null;
  const penaltyAmount = penaltyPct !== null ? (depositNum * penaltyPct) / 100 : null;
  const refundAmount = penaltyAmount !== null ? depositNum - penaltyAmount : null;

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

  // Show cached fee estimates immediately; the fresh simulation follows.
  // Derived during render so no extra state or render pass is needed.
  const cachedEstimate = useMemo(() => {
    if (!isOpen || !publicKey) return null;
    return peekCachedEstimate("withdraw", publicKey);
  }, [isOpen, publicKey]);

  const shownEstimate = estimate ?? cachedEstimate;
  const estimateFromCache = estimate === null && cachedEstimate !== null;

  useEffect(() => {
    if (!isOpen || !publicKey) return;

    let active = true;
    setEstimatingTx(true);
    setBuildError(null);

    buildWithdrawTx(
      publicKey,
      maxFeeStroops !== null ? { maxFeeStroops: String(maxFeeStroops) } : {}
    )
      .then((result) => {
        if (!active) return;
        setTxXdr(result.xdr);
        setEstimate(result.estimate);
      })
      .catch((error) => {
        if (!active) return;
        setTxXdr(null);
        setBuildError(formatTransactionErrorMessage(error));
      })
      .finally(() => {
        if (active) setEstimatingTx(false);
      });

    return () => {
      active = false;
    };
  }, [isOpen, publicKey, maxFeeStroops]);

  useEffect(() => {
    if (txPhase !== "pending" || !txHash) return;

    if (txMonitor.phase === "confirmed") {
      setTxPhase("success");
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

  // Losing the wallet mid-signature must return the modal to an actionable state.
  useEffect(() => {
    if (isConnected) return;
    if (txPhase === "signing" || txPhase === "simulating") {
      setTxError(walletError?.message ?? WALLET_ERROR_MESSAGES.disconnected);
      setRecoveryHint("Reconnect your wallet, then retry the withdrawal.");
      setCanRetry(true);
      setTxPhase("error");
      setSubmitting(false);
    }
  }, [isConnected, txPhase, walletError]);

  const submit = useCallback(async () => {
    if (!publicKey || !confirmed || !txXdr) return;
    const xdr = txXdr;

    setSubmitting(true);
    setTxError(null);
    setRecoveryHint(null);
    setCanRetry(false);
    setTxHash(null);
    setTxPhase("signing");

    try {
      const hash = await signAndSubmit(xdr);
      setTxHash(hash);
      setTxPhase("pending");
    } catch (error) {
      if (error instanceof WalletSignatureError) {
        setTxError(error.wallet.message);
        setRecoveryHint(
          error.wallet.kind === "rejected"
            ? "Nothing was submitted and no penalty was charged. Approve the request in Freighter to continue."
            : error.wallet.detail ?? null
        );
        setCanRetry(error.wallet.kind !== "not_installed");
      } else {
        setTxError(formatTransactionErrorMessage(error));
        setCanRetry(true);
      }
      setTxPhase("error");
    } finally {
      setSubmitting(false);
    }
  }, [confirmed, publicKey, txXdr]);

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
      setConfirmed(false);
      setTxXdr(null);
      setMaxFeeStroops(null);
      onClose();
    }
  }

  const usableXdr = publicKey ? txXdr : null;

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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-md bg-[var(--bg-card)] border border-[var(--border-color)] shadow-2xl rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between p-5 border-b border-[var(--border-color)]">
          <h2 className="text-lg font-bold text-[var(--text-primary)]">Early Withdrawal</h2>
          <button
            onClick={onClose}
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

          {loadingConfig ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-[var(--accent-primary)]" />
              <span className="ml-3 text-sm text-[var(--text-secondary)]">
                Loading contract config...
              </span>
            </div>
          ) : (
            <>
              <div className="space-y-3 p-4 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)]">
                <div className="flex justify-between text-sm">
                  <span className="text-[var(--text-secondary)]">Deposited amount</span>
                  <span className="text-[var(--text-primary)] font-mono">
                    {depositNum.toLocaleString()} USDC
                  </span>
                </div>
                {penaltyPct !== null && (
                  <div className="flex justify-between text-sm">
                    <span className="text-[var(--text-secondary)]">Early exit penalty</span>
                    <span className="text-[var(--warning)] font-mono">
                      {penaltyPct}% ({penaltyBps} bps)
                    </span>
                  </div>
                )}
                {penaltyAmount !== null && (
                  <div className="flex justify-between text-sm">
                    <span className="text-[var(--text-secondary)]">Penalty amount</span>
                    <span className="text-[var(--error)] font-mono">
                      -{penaltyAmount.toLocaleString()} USDC
                    </span>
                  </div>
                )}
                {refundAmount !== null && (
                  <div className="flex justify-between text-sm pt-2 border-t border-[var(--border-color)]">
                    <span className="text-[var(--text-secondary)] font-semibold">
                      Estimated refund
                    </span>
                    <span className="text-[var(--success)] font-mono font-bold">
                      {refundAmount.toLocaleString()} USDC
                    </span>
                  </div>
                )}
                <div className="flex justify-between border-t border-[var(--border-color)] pt-2 text-xs">
                  <span className="text-[var(--text-muted)]">Max network fee</span>
                  <span className="font-mono text-[var(--text-secondary)]">
                    {feeSummary.label}
                    {feeSummary.usd ? ` · ~$${feeSummary.usd}` : ""}
                  </span>
                </div>
              </div>

              <GasFeeAdjuster
                estimate={shownEstimate}
                value={maxFeeStroops}
                onChange={setMaxFeeStroops}
                xlmPriceUsd={xlmPrice}
                loading={estimatingTx}
                disabled={submitting}
                fromCache={estimateFromCache}
              />

              {buildError && (
                <p role="alert" className="text-xs text-[var(--error)]">
                  {buildError}
                </p>
              )}

              <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-[var(--warning)] shrink-0 mt-0.5" />
                  <div className="text-sm text-[var(--text-secondary)]">
                    Early withdrawal applies a penalty of{" "}
                    <strong className="text-[var(--text-primary)]">{penaltyPct}%</strong> of your
                    deposited amount. This action cannot be undone.
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
                onClick={submit}
                disabled={
                  !confirmed || submitting || estimatingTx || !usableXdr || walletBlocked
                }
                className="w-full btn-primary justify-center disabled:opacity-40"
              >
                {submitting || estimatingTx ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-4 h-4" />
                )}
                {submitting
                  ? "Processing..."
                  : estimatingTx
                    ? "Simulating…"
                    : "Confirm & Sign Withdrawal"}
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
        recoveryHint={recoveryHint}
        onRetry={canRetry ? submit : undefined}
        retrying={submitting}
        onClose={handleTransactionModalClose}
      />
    </div>
  );
}
