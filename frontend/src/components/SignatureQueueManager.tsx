"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Clock, Fingerprint, ShieldCheck, Upload } from "lucide-react";
import { useWallet } from "@/context/WalletContext";
import { useToast } from "@/context/ToastContext";
import { QuorumProgressBar } from "./governance/QuorumProgressBar";
import { useSignatureQueueStore } from "@/lib/signatureQueueStore";
import { castMilestoneVote, fetchMilestoneSigningStatus, submitSignedEnvelope } from "@/lib/milestoneSigning";

export interface SignatureQueueManagerProps {
  proposalId: string;
  onFullyApproved?: () => void;
  pollIntervalMs?: number;
}

function shortAddress(address: string): string {
  if (!address) return "—";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function SignatureQueueManager({
  proposalId,
  onFullyApproved,
  pollIntervalMs = 3000,
}: SignatureQueueManagerProps) {
  const { publicKey } = useWallet();
  const { toast } = useToast();

  const cachedProposal = useSignatureQueueStore((s) => s.proposals[proposalId] ?? null);
  const recordSignature = useSignatureQueueStore((s) => s.recordSignature);
  const addProposal = useSignatureQueueStore((s) => s.addProposal);
  const getNextPendingSigner = useSignatureQueueStore((s) => s.getNextPendingSigner);

  const [serverStatus, setServerStatus] = useState<{
    currentWeight: number;
    requiredWeight: number;
    totalWeight: number;
    status: string;
    signers: Array<{ address: string; label: string; weight: number; status: string }>;
  } | null>(null);

  const [isSigning, setIsSigning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const hasNotifiedApproval = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const latest = await fetchMilestoneSigningStatus(proposalId);
      setServerStatus(latest);

      if (!cachedProposal) {
        addProposal(
          latest.proposalId,
          latest.milestoneId,
          latest.evidenceCid,
          latest.signers,
          latest.requiredWeight
        );
      }

      if (latest.status === "Passed" && !hasNotifiedApproval.current) {
        hasNotifiedApproval.current = true;
        onFullyApproved?.();
      }
    } catch {
      // silent retry
    }
  }, [proposalId, cachedProposal, addProposal, onFullyApproved]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), pollIntervalMs);
    return () => clearInterval(interval);
  }, [refresh, pollIntervalMs]);

  const nextPending = cachedProposal ? getNextPendingSigner(proposalId) : null;
  const connectedIsNext =
    nextPending && publicKey && nextPending.address === publicKey;

  const handleSign = useCallback(async () => {
    if (!publicKey || isSigning) return;

    setIsSigning(true);
    try {
      const signedEnvelope = `signed:${proposalId}:${publicKey}:${Date.now()}`;

      const updated = await castMilestoneVote(proposalId, publicKey, signedEnvelope);

      recordSignature(proposalId, publicKey, signedEnvelope);

      toast({
        variant: "success",
        title: "Vote cast",
        message: "Your signature has been recorded on the proposal.",
      });

      setServerStatus(updated);

      if (updated.status === "Passed" && !hasNotifiedApproval.current) {
        hasNotifiedApproval.current = true;
        onFullyApproved?.();
      }
    } catch (err) {
      toast({
        variant: "error",
        title: "Vote failed",
        message: err instanceof Error ? err.message : "Could not cast vote.",
      });
    } finally {
      setIsSigning(false);
    }
  }, [proposalId, publicKey, isSigning, recordSignature, toast, onFullyApproved]);

  const handleSubmit = useCallback(async () => {
    if (!cachedProposal || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const result = await submitSignedEnvelope(cachedProposal.transactionEnvelope);
      setTxHash(result.txHash);
      toast({
        variant: "success",
        title: "Transaction submitted",
        message: `Envelope submitted to network. TX: ${result.txHash.slice(0, 16)}…`,
      });
    } catch (err) {
      toast({
        variant: "error",
        title: "Submission failed",
        message: err instanceof Error ? err.message : "Could not submit transaction.",
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [cachedProposal, isSubmitting, toast]);

  const status = serverStatus || cachedProposal;
  if (!status) {
    return (
      <div
        data-testid="signature-queue-loading"
        className="mt-4 flex items-center gap-2 rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] p-4 text-sm text-[var(--text-muted)]"
      >
        <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
        Loading signing queue…
      </div>
    );
  }

  const isPassed = status.status === "Passed";
  const signers = "signers" in status ? status.signers : [];
  const currentWeight = status.currentWeight;
  const requiredWeight = status.requiredWeight;
  const totalWeight = status.totalWeight;
  const quorumPercent = Math.round((requiredWeight / totalWeight) * 100);

  return (
    <div
      data-testid="signature-queue-panel"
      className="mt-4 space-y-4 rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] p-4"
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Signature Queue
        </p>
        {isPassed && (
          <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-semibold text-emerald-400">
            Quorum reached
          </span>
        )}
      </div>

      <QuorumProgressBar
        currentVotes={currentWeight}
        requiredVotes={requiredWeight}
        quorumThresholdPercent={quorumPercent}
      />

      <ul className="space-y-1.5">
        {signers.map((signer, idx) => {
          const isApproved = signer.status === "approved";
          const isNext = nextPending?.address === signer.address;
          const isConnectedSigner = publicKey === signer.address;

          return (
            <li
              key={signer.address}
              data-testid="queue-signer-row"
              data-status={signer.status}
              data-next={isNext ? "true" : "false"}
              className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 transition-all ${
                isNext && !isPassed
                  ? "bg-amber-500/10 ring-1 ring-amber-500/30"
                  : isApproved
                    ? "bg-emerald-500/5"
                    : "bg-[var(--bg-secondary)]"
              }`}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                {isApproved ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                ) : (
                  <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                    <span className="absolute h-full w-full animate-ping rounded-full bg-amber-400/40" />
                    <Clock className="relative h-4 w-4 text-amber-500" />
                  </span>
                )}
                <span className="truncate text-sm text-[var(--text-secondary)]">
                  {signer.label}
                </span>
                {isConnectedSigner && (
                  <span className="rounded-full bg-cyan-500/15 px-2 py-0.5 text-[10px] font-bold text-cyan-400">
                    YOU
                  </span>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-2 text-xs">
                <span className="text-[var(--text-muted)]">
                  {shortAddress(signer.address)}
                  <span className="ml-1">· w{signer.weight}</span>
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 font-semibold ${
                    isApproved
                      ? "bg-emerald-500/15 text-emerald-400"
                      : isNext
                        ? "bg-amber-500/20 text-amber-400"
                        : "bg-zinc-700/50 text-zinc-400"
                  }`}
                >
                  {isApproved ? "Signed" : isNext ? "Needs signature" : "Awaiting"}
                </span>
              </div>
            </li>
          );
        })}
      </ul>

      {!isPassed && nextPending && (
        <div
          data-testid="action-prompt"
          className={`rounded-lg p-3 text-sm ${
            connectedIsNext
              ? "border border-cyan-500/30 bg-cyan-500/10"
              : "border border-[var(--border-color)] bg-[var(--bg-secondary)]"
          }`}
        >
          {connectedIsNext ? (
            <div className="flex flex-col gap-2">
              <p className="flex items-center gap-2 font-semibold text-cyan-400">
                <Fingerprint className="h-4 w-4" />
                Your signature is required
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                You are the next required signer. Review the evidence and sign to approve this
                milestone.
              </p>
              <button
                type="button"
                onClick={() => void handleSign()}
                disabled={isSigning}
                className="mt-1 flex w-full items-center justify-center gap-2 rounded-lg bg-cyan-600 py-2.5 text-sm font-bold text-white transition-all hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-6"
              >
                {isSigning ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Signing…
                  </>
                ) : (
                  <>
                    <Fingerprint className="h-4 w-4" />
                    Sign Now
                  </>
                )}
              </button>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-[var(--text-muted)]">
              <Clock className="h-4 w-4 shrink-0" />
              Waiting for{" "}
              <span className="font-semibold text-[var(--text-secondary)]">
                {nextPending.label}
              </span>{" "}
              to sign ({shortAddress(nextPending.address)})
            </p>
          )}
        </div>
      )}

      {isPassed && !txHash && !isSubmitting && (
        <div
          data-testid="quorum-reached-banner"
          className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3"
        >
          <p className="flex items-center gap-2 text-sm font-semibold text-emerald-400">
            <ShieldCheck className="h-4 w-4 shrink-0" />
            Quorum reached
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            All required signatures collected. Submit the transaction envelope to the network.
          </p>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={isSubmitting}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 py-2.5 text-sm font-bold text-white transition-all hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-6"
          >
            {isSubmitting ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Submitting…
              </>
            ) : (
              <>
                <Upload className="h-4 w-4" />
                Submit to Network
              </>
            )}
          </button>
        </div>
      )}

      {txHash && (
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
          <p className="flex items-center gap-2 text-sm font-semibold text-emerald-400">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            Transaction submitted
          </p>
          <p className="mt-1 text-xs font-mono text-[var(--text-muted)] break-all">
            TX: {txHash}
          </p>
        </div>
      )}
    </div>
  );
}
