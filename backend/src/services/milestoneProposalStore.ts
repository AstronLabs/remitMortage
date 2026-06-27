function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export type MilestoneProposalStatus = "Open" | "Passed" | "Rejected";

export interface MilestoneProposal {
  id: string;
  milestoneId: string;
  evidenceCid: string;
  status: MilestoneProposalStatus;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

const store: Map<string, MilestoneProposal> = new Map();

export function createProposal(milestoneId: string, evidenceCid: string): MilestoneProposal {
  const id = makeId();
  const now = new Date().toISOString();
  const proposal: MilestoneProposal = {
    id,
    milestoneId,
    evidenceCid,
    status: "Open",
    createdAt: now,
    updatedAt: now,
  };
  store.set(id, proposal);
  return proposal;
}

export function getProposal(id: string): MilestoneProposal | null {
  return store.get(id) ?? null;
}

export function listProposals(): MilestoneProposal[] {
  return Array.from(store.values());
}

export function updateProposal(
  id: string,
  patch: Partial<Pick<MilestoneProposal, "status" | "reason">>
): MilestoneProposal | null {
  const existing = store.get(id);
  if (!existing) return null;
  const updated: MilestoneProposal = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  store.set(id, updated);
  return updated;
}

export function _clearProposalStore(): void {
  store.clear();
}
