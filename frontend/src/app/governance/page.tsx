"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState, useEffect, useCallback } from "react";
import {
  ShieldAlert,
  CheckCircle2,
  Clock,
  Check,
  Eye,
  Fingerprint,
  Upload,
} from "lucide-react";
import { QuorumProgressBar } from "../../components/governance/QuorumProgressBar";
import { EvidenceDrawer } from "../../components/governance/EvidenceDrawer";
import {
  MultisigApprovalCard,
  type GovernanceSigner,
} from "../../components/governance/MultisigApprovalCard";
import { useWallet } from "@/context/WalletContext";
import { useSignatureQueueStore } from "@/lib/signatureQueueStore";
import {
  castMilestoneVote,
  fetchMilestoneSigningStatus,
  submitSignedEnvelope,
} from "@/lib/milestoneSigning";

const toast = {
  success: (msg: string) => console.log("Toast success:", msg),
  error: (msg: string) => console.error("Toast error:", msg),
};

const useCommitteeMember = () => {
  const [isMember, setIsMember] = useState<boolean | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setIsMember(true), 1200);
    return () => clearTimeout(timer);
  }, []);

  return { isMember };
};

const mockSigners: GovernanceSigner[] = [
  {
    address: "GABC1234567890XYZABC1234567890XYZABC1234567890",
    label: "Committee Lead",
    weight: 2,
    status: "approved",
  },
  {
    address: "GDEF1234567890XYZDEF1234567890XYZDEF1234567890",
    label: "Legal Review",
    weight: 1,
    status: "approved",
  },
  {
    address: "GHIJ1234567890XYZGHIJ1234567890XYZGHIJ1234567890",
    label: "Finance Board",
    weight: 1,
    status: "pending",
  },
];

interface Proposal {
  id: string;
  proposalId: string;
  milestoneTitle: string;
  contractor: string;
  amount: string;
  ipfsCid: string;
  currentWeight: number;
  requiredWeight: number;
  totalSignerWeight: number;
  signers: GovernanceSigner[];
  status: "approved" | "pending";
  expiration: string;
}

const mockApprovalProposals: Proposal[] = [
  {
    id: "approval_1",
    proposalId: "prop_mock_1",
    milestoneTitle: "Phase 1: Foundation & Grading",
    contractor: "BuildWell Construction LLC",
    amount: "50,000 USDC",
    ipfsCid: "QmTestHash12345abcdef",
    currentWeight: 3,
    requiredWeight: 3,
    totalSignerWeight: 4,
    signers: mockSigners,
    status: "approved" as const,
    expiration: "2 days",
  },
  {
    id: "approval_2",
    proposalId: "prop_mock_2",
    milestoneTitle: "Phase 2: Framing & Structural Work",
    contractor: "Structo Builders Inc.",
    amount: "120,000 USDC",
    ipfsCid: "QmAnotherHash987654abcdef",
    currentWeight: 0,
    requiredWeight: 3,
    totalSignerWeight: 4,
    signers: [
      {
        address: "GCOMMITTEELEAD00000000000000000000000000000000000000A",
        label: "Committee Lead",
        weight: 2,
        status: "pending" as const,
      },
      {
        address: "GLEGALREVIEW000000000000000000000000000000000000000B",
        label: "Legal Review",
        weight: 1,
        status: "pending" as const,
      },
      {
        address: "GFINANCEBOARD00000000000000000000000000000000000000C",
        label: "Finance Board",
        weight: 1,
        status: "pending" as const,
      },
    ],
    status: "pending" as const,
    expiration: "5 days",
  },
];

import dynamic from "next/dynamic";
const Navbar = dynamic(() => import("../../components/Navbar"), { ssr: false });

export default function GovernanceDashboard() {
  const { isMember } = useCommitteeMember();
  const { publicKey } = useWallet();
  const [proposals, setProposals] = useState(mockApprovalProposals);
  const [selectedEvidenceCid, setSelectedEvidenceCid] = useState<string | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isVoting, setIsVoting] = useState<string | null>(null);
  const [submittingTx, setSubmittingTx] = useState<string | null>(null);
  const [txResults, setTxResults] = useState<Record<string, string>>({});

  const cachedProposals = useSignatureQueueStore((s) => s.proposals);
  const recordSignature = useSignatureQueueStore((s) => s.recordSignature);
  const addProposal = useSignatureQueueStore((s) => s.addProposal);

  // Seed the queue store with proposals on mount
  useEffect(() => {
    proposals.forEach((p) => {
      if (p.proposalId && !cachedProposals[p.proposalId]) {
        addProposal(
          p.proposalId,
          p.id,
          p.ipfsCid,
          p.signers.map((s) => ({ address: s.address, label: s.label ?? s.address, weight: s.weight })),
          p.requiredWeight
        );
      }
    });
  }, []);

  if (isMember === null) {
    return (
      <div className="rm-app-page min-h-screen bg-[#FFFDFA] text-[#010721]">
        <Navbar />
        <div className="flex flex-col items-center justify-center pt-32 pb-20 px-6">
          <div className="relative">
            <div className="w-14 h-14 border-4 border-gray-200 border-t-[#0046A7] rounded-full animate-spin"></div>
          </div>
          <p className="mt-6 text-[#6B7280] font-medium tracking-wide animate-pulse">
            Checking committee credentials...
          </p>
        </div>
      </div>
    );
  }

  if (isMember === false) {
    return (
      <div className="rm-app-page min-h-screen bg-[#FFFDFA] text-[#010721]">
        <Navbar />
        <div className="flex items-center justify-center pt-32 pb-20 px-6">
          <div className="max-w-md w-full bg-white border border-gray-200 rounded-2xl p-8 text-center shadow-lg relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-red-500"></div>
            <div className="mx-auto w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mb-6">
              <ShieldAlert className="w-8 h-8 text-red-500" />
            </div>
            <h1 className="text-2xl font-bold text-[#010721] mb-3 tracking-tight">Access Denied</h1>
            <p className="text-[#6B7280] mb-8 leading-relaxed text-sm">
              Your connected wallet is not registered as a committee member for this Soroban
              governance module.
            </p>
            <a
              href="/"
              className="inline-block w-full py-3.5 px-4 bg-[#0046A7] hover:bg-blue-700 text-white font-semibold rounded-xl transition-all shadow-sm"
            >
              Return to Home
            </a>
          </div>
        </div>
      </div>
    );
  }

  const openEvidence = (cid: string) => {
    setSelectedEvidenceCid(cid);
    setIsDrawerOpen(true);
  };

  const handleApprovalVote = async (proposalId: string) => {
    setIsVoting(proposalId);
    try {
      const proposal = proposals.find((p) => p.id === proposalId);
      if (!proposal || !proposal.proposalId) {
        toast.error("Proposal not found");
        return;
      }

      if (!publicKey) {
        toast.error("Connect your wallet to vote");
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));

      const signedEnvelope = `signed:${proposal.proposalId}:${publicKey}:${Date.now()}`;

      const updated = await castMilestoneVote(proposal.proposalId, publicKey, signedEnvelope);

      recordSignature(proposal.proposalId, publicKey, signedEnvelope);

      toast.success("Vote successfully cast and recorded.");

      setProposals((prev) =>
        prev.map((p) => {
          if (p.id !== proposalId) return p;
          const newWeight = updated.currentWeight;
          return {
            ...p,
            currentWeight: newWeight,
            status: newWeight >= p.requiredWeight ? ("approved" as const) : ("pending" as const),
            signers: p.signers.map((s) => ({
              ...s,
              status:
                updated.signers.find((us) => us.address === s.address)?.status ?? s.status,
            })),
          };
        })
      );
    } catch {
      toast.error("Failed to cast vote. Transaction rejected.");
    } finally {
      setIsVoting(null);
    }
  };

  const handleSubmit = async (proposalId: string) => {
    setSubmittingTx(proposalId);
    try {
      const proposal = proposals.find((p) => p.id === proposalId);
      if (!proposal || !proposal.proposalId) {
        toast.error("Proposal not found");
        return;
      }

      const cached = cachedProposals[proposal.proposalId];
      if (!cached) {
        toast.error("No cached envelope found");
        return;
      }

      const result = await submitSignedEnvelope(cached.transactionEnvelope);
      setTxResults((prev) => ({ ...prev, [proposalId]: result.txHash }));
      toast.success(`Transaction submitted. TX: ${result.txHash.slice(0, 16)}…`);
    } catch {
      toast.error("Failed to submit transaction.");
    } finally {
      setSubmittingTx(null);
    }
  };

  return (
    <div className="rm-app-page min-h-screen bg-[#FFFDFA] text-[#010721]">
      <Navbar />
      <div className="max-w-7xl mx-auto px-6 pt-32 pb-20">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-10 space-y-4 md:space-y-0">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-[#010721] mb-2">
              Signer <span className="text-[#0046A7]">Dashboard</span>
            </h1>
            <p className="text-[#6B7280] text-sm md:text-base font-medium">
              Review milestone evidence, sign proposals sequentially, and submit completed
              envelopes to the network.
            </p>
          </div>
          <div className="flex items-center space-x-2.5 bg-emerald-50 border border-emerald-200 px-4 py-2 rounded-full shadow-sm">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span className="text-emerald-700 font-semibold text-xs tracking-wide">
              Committee Active
            </span>
          </div>
        </div>

        {/* Multisig Approval Cards with signing queue */}
        <section className="mb-12">
          <h2 className="text-xl font-bold text-zinc-100 mb-1">Approval Requests</h2>
          <p className="text-zinc-400 text-sm mb-6">
            Review milestone evidence and cast your weighted vote toward quorum.
          </p>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {proposals.map((proposal) => {
              const isQuorumMet = proposal.currentWeight >= proposal.requiredWeight;
              const cached = proposal.proposalId
                ? cachedProposals[proposal.proposalId]
                : null;
              const txHash = proposal.id ? txResults[proposal.id] : null;

              return (
                <article
                  key={proposal.id}
                  className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5 space-y-5 shadow-lg"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-bold text-zinc-100 leading-tight">
                        {proposal.milestoneTitle}
                      </h3>
                      <p className="text-sm text-zinc-400 mt-0.5">{proposal.contractor}</p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
                        proposal.status === "approved"
                          ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                          : "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                      }`}
                    >
                      {proposal.status === "approved" ? "Approved" : "Pending"}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-4 text-sm">
                    <div className="flex flex-col">
                      <span className="text-zinc-500 text-xs uppercase tracking-wider">
                        Disbursement
                      </span>
                      <span className="text-zinc-100 font-semibold">{proposal.amount}</span>
                    </div>
                    <button
                      onClick={() => openEvidence(proposal.ipfsCid)}
                      className="flex items-center gap-1.5 text-cyan-400 hover:text-cyan-300 transition-colors"
                    >
                      <Eye className="h-3.5 w-3.5" />
                      View evidence (IPFS)
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    <QuorumProgressBar
                      currentVotes={proposal.currentWeight}
                      requiredVotes={proposal.requiredWeight}
                      quorumThresholdPercent={Math.round(
                        (proposal.requiredWeight / proposal.totalSignerWeight) * 100
                      )}
                    />
                    <p className="text-xs text-zinc-500">
                      {proposal.currentWeight} / {proposal.requiredWeight} weight accumulated
                      {isQuorumMet
                        ? " — quorum reached"
                        : ` — ${proposal.requiredWeight - proposal.currentWeight} more needed`}
                    </p>
                  </div>

                  {/* Signer list */}
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                      Signature Queue ({proposal.signers.length})
                    </p>
                    <ul className="space-y-1.5">
                      {proposal.signers.map((signer) => {
                        const isApproved = signer.status === "approved";
                        const isConnectedSigner = publicKey === signer.address;
                        const isNext =
                          !isApproved &&
                          !proposal.signers
                            .slice(
                              0,
                              proposal.signers.findIndex((s) => s.address === signer.address)
                            )
                            .some((s) => s.status === "pending");

                        return (
                          <li
                            key={signer.address}
                            className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 transition-all ${
                              isNext && !isApproved && !isQuorumMet
                                ? "bg-amber-500/10 ring-1 ring-amber-500/30"
                                : isApproved
                                  ? "bg-emerald-500/5"
                                  : "bg-zinc-800/60"
                            }`}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              {isApproved ? (
                                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                              ) : (
                                <div className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                                  <span className="absolute h-full w-full animate-ping rounded-full bg-amber-400/40" />
                                  <Clock className="relative h-4 w-4 text-amber-500" />
                                </div>
                              )}
                              <span
                                className={`font-mono text-xs truncate ${
                                  isApproved ? "text-emerald-300" : "text-zinc-400"
                                }`}
                              >
                                {signer.label ?? signer.address.slice(0, 8)}
                              </span>
                              {isConnectedSigner && (
                                <span className="rounded-full bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-bold text-cyan-400">
                                  YOU
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 shrink-0 text-xs">
                              <span className="text-zinc-500">w{signer.weight}</span>
                              <span
                                className={`rounded-full px-2 py-0.5 ${
                                  isApproved
                                    ? "bg-emerald-500/15 text-emerald-400"
                                    : isNext && !isQuorumMet
                                      ? "bg-amber-500/20 text-amber-400"
                                      : "bg-zinc-700 text-zinc-400"
                                }`}
                              >
                                {isApproved ? "Signed" : isNext ? "Needs sig" : "Waiting"}
                              </span>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>

                  {/* Action prompt for current signer */}
                  {!isQuorumMet &&
                    (() => {
                      const nextPendingSigner = proposal.signers.find(
                        (s) => s.status === "pending"
                      );
                      if (!nextPendingSigner) return null;
                      const isYou = publicKey === nextPendingSigner.address;

                      return (
                        <div
                          className={`rounded-lg p-3 text-sm ${
                            isYou
                              ? "border border-cyan-500/30 bg-cyan-500/10"
                              : "border border-zinc-800 bg-zinc-800/60"
                          }`}
                        >
                          {isYou ? (
                            <div className="flex flex-col gap-2">
                              <p className="flex items-center gap-2 font-semibold text-cyan-400">
                                <Fingerprint className="h-4 w-4" />
                                Your signature is required
                              </p>
                              <p className="text-xs text-zinc-400">
                                You are the next signer in queue. Review evidence and sign.
                              </p>
                              <button
                                type="button"
                                onClick={() => void handleApprovalVote(proposal.id)}
                                disabled={isVoting === proposal.id}
                                className="mt-1 flex w-full items-center justify-center gap-2 rounded-lg bg-cyan-600 py-2.5 text-sm font-bold text-white transition-all hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-6"
                              >
                                {isVoting === proposal.id ? (
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
                            <p className="flex items-center gap-2 text-zinc-400">
                              <Clock className="h-4 w-4 shrink-0" />
                              Waiting for{" "}
                              <span className="font-semibold text-zinc-200">
                                {nextPendingSigner.label}
                              </span>{" "}
                              to sign
                            </p>
                          )}
                        </div>
                      );
                    })()}

                  {/* Submit button when quorum met */}
                  {isQuorumMet && !txHash && (
                    <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                      <p className="flex items-center gap-2 text-sm font-semibold text-emerald-400">
                        <CheckCircle2 className="h-4 w-4 shrink-0" />
                        Quorum reached
                      </p>
                      <p className="mt-1 text-xs text-zinc-400">
                        All required signatures collected. Submit to the network.
                      </p>
                      <button
                        type="button"
                        onClick={() => void handleSubmit(proposal.id)}
                        disabled={submittingTx === proposal.id}
                        className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 py-2.5 text-sm font-bold text-white transition-all hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-6"
                      >
                        {submittingTx === proposal.id ? (
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

                  {/* Transaction hash display */}
                  {txHash && (
                    <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                      <p className="flex items-center gap-2 text-sm font-semibold text-emerald-400">
                        <CheckCircle2 className="h-4 w-4 shrink-0" />
                        Transaction submitted
                      </p>
                      <p className="mt-1 text-xs font-mono text-zinc-400 break-all">
                        TX: {txHash}
                      </p>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      </div>

      <EvidenceDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        ipfsCid={selectedEvidenceCid || ""}
      />
    </div>
  );
}
