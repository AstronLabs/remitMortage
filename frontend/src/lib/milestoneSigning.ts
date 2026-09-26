// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

export type SignerVoteStatus = "approved" | "pending";

export interface MilestoneSigner {
  address: string;
  label: string;
  weight: number;
  status: SignerVoteStatus;
}

export interface MilestoneSigningStatus {
  proposalId: string;
  milestoneId: string;
  evidenceCid: string;
  status: "Open" | "Passed";
  requiredWeight: number;
  totalWeight: number;
  currentWeight: number;
  signers: MilestoneSigner[];
  createdAt: string;
  updatedAt: string;
}

/** Creates a disbursement proposal and returns its initial signing status (0 votes cast). */
export async function createMilestoneProposal(
  milestoneId: string,
  evidenceCid: string
): Promise<MilestoneSigningStatus> {
  const res = await fetch("/api/milestone/proposals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ milestoneId, evidenceCid }),
  });
  if (!res.ok) {
    throw new Error("Failed to create disbursement proposal");
  }
  return res.json();
}

/** Fetches the current signer weights and per-signer approval status for a proposal. */
export async function fetchMilestoneSigningStatus(
  proposalId: string
): Promise<MilestoneSigningStatus> {
  const res = await fetch(`/api/milestone/proposals/${proposalId}/signing-status`);
  if (!res.ok) {
    throw new Error("Failed to fetch signing status");
  }
  return res.json();
}

/** Casts a vote for the connected signer on a milestone proposal. */
export async function castMilestoneVote(
  proposalId: string,
  signerAddress: string,
  transactionEnvelope: string
): Promise<MilestoneSigningStatus> {
  const res = await fetch(`/api/milestone/proposals/${proposalId}/vote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signerAddress, transactionEnvelope }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Vote failed" }));
    throw new Error(err.error || "Failed to cast vote");
  }
  return res.json();
}

/** Submits a fully-signed transaction envelope to the network. */
export async function submitSignedEnvelope(
  envelope: string
): Promise<{ txHash: string }> {
  const res = await fetch("/api/milestone/proposals/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ envelope }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Submission failed" }));
    throw new Error(err.error || "Failed to submit transaction");
  }
  return res.json();
}
