// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

export interface EvidenceRevision {
  id: string;
  cid: string;
  sha256?: string;
  url: string;
  label: string;
  description?: string;
  costEstimate?: number;
  size?: number;
  uploadedAt: string;
  uploader?: string;
  version: number;
}

const store = new Map<string, EvidenceRevision[]>();

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function addRevision(milestoneId: string, data: Omit<EvidenceRevision, "id" | "version" | "uploadedAt"> & { uploadedAt?: string }): EvidenceRevision {
  const list = store.get(milestoneId) ?? [];
  const rev: EvidenceRevision = {
    id: makeId(),
    version: list.length + 1,
    uploadedAt: data.uploadedAt ?? new Date().toISOString(),
    ...data,
  };
  list.push(rev);
  store.set(milestoneId, list);
  return rev;
}

export function getRevisions(milestoneId: string): EvidenceRevision[] {
  return [...(store.get(milestoneId) ?? [])];
}

export function setRevisions(milestoneId: string, revisions: EvidenceRevision[]): void {
  store.set(milestoneId, [...revisions]);
}

export function clearRevisions(milestoneId?: string): void {
  if (milestoneId) store.delete(milestoneId);
  else store.clear();
}

export function _resetMilestoneRevisionsStore(): void {
  store.clear();
}
