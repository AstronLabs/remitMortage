"use client";

import React from "react";
import { CheckCircle2, Clock, ExternalLink, Vote } from "lucide-react";
import { QuorumProgressBar } from "./QuorumProgressBar";

export type SignerStatus = "approved" | "pending";

export interface GovernanceSigner {
  address: string;
  label?: string;
  weight: number;
  status: SignerStatus;
}

export interface MultisigApprovalCardProps {
  id: string;
  milestoneTitle: string;
  contractor: string;
  amount: string;
  ipfsCid: string;
  /** Sum of weights of signers who have already approved. */
  currentWeight: number;
  /** Minimum total weight required to reach quorum. */
  requiredWeight: number;
  /** Total weight of all registered signers (used to display quorum %). */
  totalSignerWeight: number;
  signers: GovernanceSigner[];
  status: "pending" | "approved" | "expired";
  expiration?: string;
  /** Called when the user clicks "Cast Vote". */
  onVote?: (id: string) => void | Promise<void>;
  isVoting?: boolean;
}

function shortAddress(address: string): string {
  if (!address) return "—";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const STATUS_BADGE: Record<
  MultisigApprovalCardProps["status"],
  { label: string; className: string }
> = {
  pending: {
    label: "Pending",
    className: "bg-amber-500/15 text-amber-400 border border-amber-500/30",
  },
  approved: {
    label: "Approved",
    className:
      "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30",
  },
  expired: {
    label: "Expired",
    className: "bg-red-500/15 text-red-400 border border-red-500/30",
  },
};

export function MultisigApprovalCard({
  id,
  milestoneTitle,
  contractor,
  amount,
  ipfsCid,
  currentWeight,
  requiredWeight,
  totalSignerWeight,
  signers,
  status,
  expiration,
  onVote,
  isVoting = false,
}: MultisigApprovalCardProps) {
  const badge = STATUS_BADGE[status];
  const quorumPercent = Math.round((requiredWeight / totalSignerWeight) * 100);
  const isQuorumMet = currentWeight >= requiredWeight;
  const canVote = status === "pending" && !isQuorumMet;

  const ipfsGatewayUrl = `https://ipfs.io/ipfs/${ipfsCid}`;

  return (
    <article className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5 space-y-5 shadow-lg">
      {/* Header row */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-zinc-100 leading-tight">
            {milestoneTitle}
          </h3>
          <p className="text-sm text-zinc-400 mt-0.5">{contractor}</p>
        </div>
        <span
          className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${badge.className}`}
        >
          {badge.label}
        </span>
      </div>

      {/* Amount + evidence link */}
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <div className="flex flex-col">
          <span className="text-zinc-500 text-xs uppercase tracking-wider">
            Disbursement
          </span>
          <span className="text-zinc-100 font-semibold">{amount}</span>
        </div>

        <a
          href={ipfsGatewayUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-cyan-400 hover:text-cyan-300 transition-colors"
        >
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          View evidence (IPFS)
        </a>

        {expiration && (
          <div className="flex items-center gap-1.5 text-zinc-500 text-xs ml-auto">
            <Clock className="h-3.5 w-3.5 shrink-0" />
            Expires in {expiration}
          </div>
        )}
      </div>

      {/* Quorum progress */}
      <div className="space-y-1.5">
        <QuorumProgressBar
          currentVotes={currentWeight}
          requiredVotes={requiredWeight}
          quorumThresholdPercent={quorumPercent}
        />
        <p className="text-xs text-zinc-500">
          {currentWeight} / {requiredWeight} weight accumulated
          {isQuorumMet ? " — quorum reached" : ` — ${requiredWeight - currentWeight} more needed`}
        </p>
      </div>

      {/* Signer list */}
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Signers ({signers.length})
        </p>
        <ul className="space-y-1.5">
          {signers.map((signer) => (
            <li
              key={signer.address}
              className="flex items-center justify-between gap-3 rounded-lg bg-zinc-800/60 px-3 py-2"
            >
              <div className="flex items-center gap-2 min-w-0">
                {signer.status === "approved" ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                ) : (
                  <Clock className="h-4 w-4 shrink-0 text-zinc-500" />
                )}
                <span
                  className={`font-mono text-xs truncate ${
                    signer.status === "approved"
                      ? "text-emerald-300"
                      : "text-zinc-400"
                  }`}
                >
                  {signer.label ?? shortAddress(signer.address)}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0 text-xs">
                <span className="text-zinc-500">weight {signer.weight}</span>
                <span
                  className={`rounded-full px-2 py-0.5 ${
                    signer.status === "approved"
                      ? "bg-emerald-500/15 text-emerald-400"
                      : "bg-zinc-700 text-zinc-400"
                  }`}
                >
                  {signer.status === "approved" ? "Approved" : "Pending"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Vote button */}
      {canVote && onVote && (
        <button
          type="button"
          onClick={() => void onVote(id)}
          disabled={isVoting}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-600 py-3 text-sm font-bold text-white transition-all hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-6"
        >
          {isVoting ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Casting vote…
            </>
          ) : (
            <>
              <Vote className="h-4 w-4" />
              Cast Vote
            </>
          )}
        </button>
      )}

      {isQuorumMet && status === "approved" && (
        <p className="flex items-center gap-2 text-sm text-emerald-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          Quorum reached — disbursement authorized
        </p>
      )}
    </article>
  );
}
