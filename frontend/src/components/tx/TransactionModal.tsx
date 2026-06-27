"use client";

import { useEffect } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import {
  formatTransactionErrorMessage,
  getTransactionExplorerLinks,
  shortenAddress,
  TRANSACTION_MODAL_STEPS,
  type TransactionModalPhase,
  type TransactionType,
} from "../../lib/transaction-status";

interface TransactionModalProps {
  isOpen: boolean;
  phase: TransactionModalPhase;
  transactionType: TransactionType;
  hash?: string | null;
  errorMessage?: string | null;
  onClose: () => void;
}

const PHASE_COPY: Record<
  Exclude<TransactionModalPhase, "idle">,
  { eyebrow: string; title: string; body: string }
> = {
  simulating: {
    eyebrow: "Simulating",
    title: "Preparing contract execution",
    body: "Estimating Soroban resources and validating the call before it reaches your wallet.",
  },
  signing: {
    eyebrow: "Awaiting Signature",
    title: "Approve the transaction in Freighter",
    body: "Your wallet approval is required before the transaction can be broadcast to Stellar.",
  },
  pending: {
    eyebrow: "Confirming on Stellar",
    title: "Broadcast complete, waiting for finality",
    body: "The transaction hash is live. We are polling the network until the contract confirms or rejects it.",
  },
  success: {
    eyebrow: "Confirmed",
    title: "Transaction confirmed on-chain",
    body: "The network accepted the transaction and the latest state is now finalized.",
  },
  error: {
    eyebrow: "Rejected",
    title: "Transaction did not complete",
    body: "The transaction was rejected before confirmation. Review the cleaned error below and retry if needed.",
  },
};

function phaseToStepIndex(phase: TransactionModalPhase): number {
  switch (phase) {
    case "simulating":
      return 1;
    case "signing":
      return 2;
    case "pending":
      return 3;
    case "success":
    case "error":
      return 4;
    default:
      return 0;
  }
}

export default function TransactionModal({
  isOpen,
  phase,
  transactionType,
  hash,
  errorMessage,
  onClose,
}: TransactionModalProps) {
  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  if (!isOpen || phase === "idle") return null;

  const canClose = phase === "success" || phase === "error";
  const copy = PHASE_COPY[phase];
  const activeStep = phaseToStepIndex(phase);
  const displayError = errorMessage ? formatTransactionErrorMessage(errorMessage) : null;

  const handleClose = () => {
    if (!canClose) return;
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4 sm:p-6">
      <button
        type="button"
        aria-label="Dismiss transaction overlay"
        data-testid="transaction-modal-backdrop"
        className="glass-overlay absolute inset-0"
        onClick={handleClose}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="transaction-modal-title"
        className="glass-modal animate-modal-pop relative w-full max-w-2xl overflow-hidden rounded-[28px] border border-white/10"
      >
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/70 to-transparent" />

        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-5 sm:px-8">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-cyan-200/70">
              {copy.eyebrow}
            </p>
            <h2 id="transaction-modal-title" className="mt-2 text-2xl font-bold text-white">
              {transactionType}
            </h2>
            <p className="mt-1 text-sm text-slate-300">{copy.title}</p>
          </div>

          <button
            type="button"
            aria-label="Close transaction modal"
            onClick={handleClose}
            disabled={!canClose}
            className="rounded-full border border-white/10 p-2 text-slate-300 transition hover:border-white/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-6 px-6 py-6 sm:px-8 sm:py-8">
          <div className="flex items-start gap-4 rounded-2xl border border-white/8 bg-white/4 px-4 py-4">
            <PhaseIcon phase={phase} />
            <div>
              <p className="text-sm leading-6 text-slate-200">{copy.body}</p>
              {!canClose && (
                <p className="mt-2 text-xs uppercase tracking-[0.18em] text-cyan-200/70">
                  Parent interactions are locked until the transaction reaches a terminal state.
                </p>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-white/8 bg-slate-950/40 px-4 py-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              {TRANSACTION_MODAL_STEPS.map((label, index) => {
                const stepNumber = index + 1;
                const isComplete = activeStep > stepNumber;
                const isActive =
                  (phase !== "success" && phase !== "error" && activeStep === stepNumber) ||
                  ((phase === "success" || phase === "error") &&
                    stepNumber === TRANSACTION_MODAL_STEPS.length);

                return (
                  <div key={label} className="flex flex-1 items-center gap-3">
                    <div
                      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border text-sm font-semibold transition-all ${
                        isComplete
                          ? "border-cyan-400 bg-cyan-400 text-slate-950"
                          : isActive
                            ? phase === "error"
                              ? "border-red-400 bg-red-500/10 text-red-300"
                              : "border-cyan-300 bg-cyan-400/10 text-cyan-100"
                            : "border-white/10 bg-white/3 text-slate-400"
                      }`}
                    >
                      {isComplete ? (
                        <CheckCircle2 className="h-5 w-5" />
                      ) : (
                        <span>{stepNumber}</span>
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                        Step {stepNumber}
                      </p>
                      <p
                        className={`text-sm ${
                          isActive || isComplete ? "text-slate-100" : "text-slate-400"
                        }`}
                      >
                        {label}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {hash && (
            <div className="rounded-2xl border border-white/8 bg-slate-950/50 px-4 py-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500">
                    Transaction Hash
                  </p>
                  <p className="mt-2 font-mono text-sm text-slate-100" title={hash}>
                    {shortenAddress(hash)}
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  {getTransactionExplorerLinks(hash).map((link) => (
                    <a
                      key={link.label}
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 rounded-full border border-white/10 px-4 py-2 text-xs font-semibold text-slate-100 transition hover:border-cyan-300/60 hover:text-cyan-100"
                    >
                      {link.label}
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ))}
                </div>
              </div>
            </div>
          )}

          {displayError && phase === "error" && (
            <div
              role="alert"
              className="rounded-2xl border border-red-400/25 bg-red-500/10 px-4 py-4 text-sm text-red-100"
            >
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-red-300/80">
                Clean Error
              </p>
              <p className="mt-2 leading-6">{displayError}</p>
            </div>
          )}

          <div className="flex items-center justify-end">
            {canClose ? (
              <button type="button" onClick={onClose} className="btn-primary !px-6 !py-3">
                Close
              </button>
            ) : (
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-slate-400">
                <ShieldAlert className="h-4 w-4" />
                Locked while pending
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function PhaseIcon({ phase }: { phase: TransactionModalPhase }) {
  if (phase === "success") {
    return (
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-300">
        <CheckCircle2 className="h-7 w-7" />
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-red-500/15 text-red-300">
        <AlertTriangle className="h-7 w-7" />
      </div>
    );
  }

  if (phase === "signing") {
    return (
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-cyan-400/10 text-cyan-100">
        <Sparkles className="h-7 w-7" />
      </div>
    );
  }

  return (
    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-cyan-400/10 text-cyan-100">
      <Loader2 className="h-7 w-7 animate-spin" />
    </div>
  );
}
