"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useCallback, useState } from "react";
import { useToast } from "@/context/ToastContext";
import EvidenceUpload from "./EvidenceUpload";
import MilestoneSubmissionForm, { MilestoneSubmission } from "./MilestoneSubmissionForm";
import MilestoneTracker, { Stage } from "./MilestoneTracker";
import MilestoneSigningProgressPanel from "./MilestoneSigningProgressPanel";
import { createMilestoneProposal } from "@/lib/milestoneSigning";
import { useSignatureQueueStore } from "@/lib/signatureQueueStore";

interface MilestoneProps {
  id: string;
  name: string;
  initialStage: Stage;
  shareId?: string;
}

export default function MilestoneCard({ id, name, initialStage, shareId }: MilestoneProps) {
  const [stage, setStage] = useState<Stage>(initialStage);
  const [cid, setCid] = useState<string | null>(null);
  const [submission, setSubmission] = useState<MilestoneSubmission | null>(null);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);
  const { toast } = useToast();

  const handleShare = useCallback(async () => {
    const url = `${window.location.origin}/share/${encodeURIComponent(shareId!)}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: `${name} — RemitMortgage`, url });
      } catch {}
    } else {
      await navigator.clipboard.writeText(url);
      toast({
        variant: "info",
        title: "Link copied",
        message: `Share this link to show ${name} progress.`,
      });
    }
  }, [shareId, name, toast]);

  const handleUploadSuccess = (uploadedCid: string) => {
    setCid(uploadedCid);
  };

  const addProposal = useSignatureQueueStore((s) => s.addProposal);

  const handleRequestDisbursement = async () => {
    if (!cid || isRequesting) return;

    setIsRequesting(true);
    try {
      const proposal = await createMilestoneProposal(id, cid);
      setProposalId(proposal.proposalId);
      addProposal(
        proposal.proposalId,
        proposal.milestoneId,
        proposal.evidenceCid,
        proposal.signers.map((s) => ({
          address: s.address,
          label: s.label,
          weight: s.weight,
        })),
        proposal.requiredWeight
      );
      toast({
        variant: "info",
        title: "Disbursement requested",
        message: `Requested disbursement for ${name} using evidence CID: ${cid}`,
      });
      setStage("Proposed");
    } catch {
      toast({
        variant: "error",
        title: "Request failed",
        message: "Could not submit the disbursement request. Please try again.",
      });
    } finally {
      setIsRequesting(false);
    }
  };

  const handleFullyApproved = () => {
    setStage("Approved");
    toast({
      variant: "success",
      title: "Quorum reached",
      message: `${name} disbursement has been approved by the governance multisig.`,
    });
  };

  return (
    <div className="p-6 bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl hover:border-[var(--border-glow)] hover:shadow-[var(--shadow-glow)] transition-all group">
      <div className="flex justify-between items-start mb-4">
        <h3 className="text-lg font-bold text-[var(--text-primary)]">{name}</h3>
        <div className="flex items-center gap-2 shrink-0">
          {shareId && (
            <button
              onClick={() => void handleShare()}
              className="text-[11px] font-semibold text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2.5 py-1 rounded-full transition-colors flex items-center gap-1.5"
              aria-label={`Share ${name}`}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-3 h-3"
              >
                <circle cx="18" cy="5" r="3" />
                <circle cx="6" cy="12" r="3" />
                <circle cx="18" cy="19" r="3" />
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
              </svg>
              Share
            </button>
          )}
          <span
            className={`px-3 py-1 rounded-full text-xs font-semibold ${
              stage === "Pending"
                ? "bg-amber-500/20 text-amber-500 border border-amber-500/30"
                : stage === "Proposed"
                  ? "bg-blue-500/20 text-blue-500 border border-blue-500/30"
                  : stage === "Approved"
                    ? "bg-indigo-500/20 text-indigo-400 border border-indigo-500/30"
                    : "bg-emerald-500/20 text-emerald-500 border border-emerald-500/30"
            }`}
          >
            {stage}
          </span>
        </div>
      </div>

      <div className="mb-6">
        <MilestoneTracker currentStage={stage} />
      </div>

      {stage === "Pending" && (
        <>
          <MilestoneSubmissionForm milestoneId={id} onSubmit={(data) => setSubmission(data)} />
          <EvidenceUpload milestoneId={id} onUploadSuccess={handleUploadSuccess} />
          <button
            onClick={() => void handleRequestDisbursement()}
            disabled={!cid || !submission?.description || isRequesting}
            className={`mt-4 w-full py-3 rounded-full font-bold transition-all flex items-center justify-center gap-2 ${
              cid && submission?.description && !isRequesting
                ? "bg-[var(--accent-primary)] text-white hover:bg-[var(--accent-primary-light)] shadow-lg hover:shadow-[var(--shadow-glow)]"
                : "bg-[var(--bg-primary)] text-[var(--text-muted)] border border-[var(--border-color)] cursor-not-allowed"
            }`}
          >
            {isRequesting ? "Requesting…" : "Request Disbursement"}
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-4 h-4"
            >
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        </>
      )}

      {stage !== "Pending" && (
        <div className="mt-4 p-4 bg-[var(--bg-primary)] rounded-md border border-[var(--border-color)]">
          <p className="text-sm text-[var(--text-secondary)] mb-2">
            Evidence Status: <span className="text-[var(--success)] font-semibold">Submitted</span>
          </p>
          {cid && <div className="text-xs text-[var(--text-muted)] break-all mb-1">CID: {cid}</div>}
          <p className="text-xs text-[var(--text-muted)]">
            {stage === "Proposed"
              ? "Awaiting governance approval for disbursement."
              : "Governance approval complete."}
          </p>

          {stage === "Proposed" && proposalId && (
            <MilestoneSigningProgressPanel
              proposalId={proposalId}
              onFullyApproved={handleFullyApproved}
            />
          )}
        </div>
      )}
    </div>
  );
}
