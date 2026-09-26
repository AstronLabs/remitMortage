// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Server-side in-memory mock of the milestone governance approver set (a
 * stand-in for reading signer weights/status from a deployed Multisig
 * Validator contract). Mirrors the existing mock pattern used by
 * `/api/milestone/upload` — no persistence, no wallet/RPC calls, values live
 * only in this Node process. Imported by Next.js route handlers only.
 */

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

export const GOVERNANCE_SIGNERS: Array<Omit<MilestoneSigner, "status">> = [
  {
    address: "GCOMMITTEELEAD00000000000000000000000000000000000000A",
    label: "Committee Lead",
    weight: 2,
  },
  {
    address: "GLEGALREVIEW000000000000000000000000000000000000000B",
    label: "Legal Review",
    weight: 1,
  },
  {
    address: "GFINANCEBOARD00000000000000000000000000000000000000C",
    label: "Finance Board",
    weight: 1,
  },
];
export const REQUIRED_WEIGHT = 3;
export const TOTAL_WEIGHT = GOVERNANCE_SIGNERS.reduce((sum, s) => sum + s.weight, 0);

const store = new Map<string, MilestoneSigningStatus>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Manually cast a vote for a specific signer address. Returns updated status or null if invalid. */
export function castVote(
  proposalId: string,
  signerAddress: string
): MilestoneSigningStatus | null {
  const proposal = store.get(proposalId);
  if (!proposal || proposal.status !== "Open") return null;

  const signer = proposal.signers.find(
    (s) => s.address === signerAddress && s.status === "pending"
  );
  if (!signer) return null;

  signer.status = "approved";
  proposal.currentWeight += signer.weight;
  proposal.updatedAt = new Date().toISOString();

  if (proposal.currentWeight >= proposal.requiredWeight) {
    proposal.status = "Passed";
    timers.delete(proposalId);
  }

  return proposal;
}

export function createMockProposal(
  milestoneId: string,
  evidenceCid: string
): MilestoneSigningStatus {
  const id = makeId();
  const now = new Date().toISOString();
  const proposal: MilestoneSigningStatus = {
    proposalId: id,
    milestoneId,
    evidenceCid,
    status: "Open",
    requiredWeight: REQUIRED_WEIGHT,
    totalWeight: TOTAL_WEIGHT,
    currentWeight: 0,
    signers: GOVERNANCE_SIGNERS.map((s) => ({ ...s, status: "pending" as const })),
    createdAt: now,
    updatedAt: now,
  };
  store.set(id, proposal);
  return proposal;
}

export function getMockSigningStatus(proposalId: string): MilestoneSigningStatus | null {
  return store.get(proposalId) ?? null;
}

/** Test helper: clears all in-memory state and pending timers. */
export function _resetMilestoneSigningStore(): void {
  timers.forEach((timer) => clearTimeout(timer));
  timers.clear();
  store.clear();
}
