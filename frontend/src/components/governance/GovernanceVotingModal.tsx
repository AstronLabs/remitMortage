// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState } from "react";
import { X, Check, XCircle, MinusCircle, AlertCircle } from "lucide-react";
import { GovernanceProposal } from "../../hooks/useGovernanceProposals";
import { QuorumProgressBar } from "./QuorumProgressBar";

interface GovernanceVotingModalProps {
  isOpen: boolean;
  onClose: () => void;
  proposal: GovernanceProposal | null;
  onVote: (proposalId: string, vote: "yes" | "no" | "abstain") => Promise<void>;
}

export function GovernanceVotingModal({
  isOpen,
  onClose,
  proposal,
  onVote,
}: GovernanceVotingModalProps) {
  const [isVoting, setIsVoting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen || !proposal) return null;

  const handleVote = async (vote: "yes" | "no" | "abstain") => {
    setIsVoting(true);
    setError(null);
    try {
      await onVote(proposal.id, vote);
      onClose();
    } catch (err: any) {
      setError(err?.message || "Failed to submit vote");
    } finally {
      setIsVoting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={isVoting ? undefined : onClose}
      />
      
      <div className="relative w-full max-w-xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-slate-800">
          <h2 className="text-xl font-bold text-white">Cast Your Vote</h2>
          <button
            onClick={onClose}
            disabled={isVoting}
            className="text-slate-400 hover:text-white transition-colors disabled:opacity-50"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[70vh]">
          <div className="mb-6">
            <h3 className="text-lg font-bold text-cyan-400 mb-2">{proposal.title}</h3>
            <p className="text-slate-300 text-sm leading-relaxed">{proposal.description}</p>
          </div>

          <div className="bg-slate-950 rounded-xl p-5 border border-slate-800 mb-6 space-y-4">
            <div className="flex justify-between items-center text-sm">
              <span className="text-slate-400 font-semibold uppercase tracking-wider text-xs">Status</span>
              <span className={`px-2.5 py-1 rounded-full text-xs font-bold uppercase ${
                proposal.status === "approved"
                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                  : "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
              }`}>
                {proposal.status}
              </span>
            </div>
            {proposal.amount && (
              <div className="flex justify-between items-center text-sm">
                <span className="text-slate-400 font-semibold uppercase tracking-wider text-xs">Requested Amount</span>
                <span className="text-white font-mono font-bold">{proposal.amount}</span>
              </div>
            )}
            <div className="flex justify-between items-center text-sm">
              <span className="text-slate-400 font-semibold uppercase tracking-wider text-xs">Expires In</span>
              <span className="text-slate-300 font-medium">{proposal.expiration}</span>
            </div>
          </div>

          <div className="mb-6">
            <QuorumProgressBar
              currentVotes={proposal.currentVotes}
              requiredVotes={proposal.requiredVotes}
              quorumThresholdPercent={proposal.quorumPercent}
            />
          </div>

          {error && (
            <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
              <p className="text-sm text-red-300">{error}</p>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="p-6 border-t border-slate-800 bg-slate-900/50 grid grid-cols-3 gap-3">
          <button
            onClick={() => handleVote("yes")}
            disabled={isVoting || proposal.status !== "pending"}
            className="flex items-center justify-center py-3 px-4 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 font-bold rounded-xl border border-emerald-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Check className="w-5 h-5 mr-1.5" />
            Yes
          </button>
          
          <button
            onClick={() => handleVote("no")}
            disabled={isVoting || proposal.status !== "pending"}
            className="flex items-center justify-center py-3 px-4 bg-red-600/20 hover:bg-red-600/30 text-red-400 font-bold rounded-xl border border-red-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <XCircle className="w-5 h-5 mr-1.5" />
            No
          </button>
          
          <button
            onClick={() => handleVote("abstain")}
            disabled={isVoting || proposal.status !== "pending"}
            className="flex items-center justify-center py-3 px-4 bg-slate-700/50 hover:bg-slate-700 text-slate-300 font-bold rounded-xl border border-slate-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <MinusCircle className="w-5 h-5 mr-1.5" />
            Abstain
          </button>
        </div>
      </div>
    </div>
  );
}
