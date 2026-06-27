import { StrKey } from "@stellar/stellar-sdk";
// lightweight id generator to avoid adding dependencies
function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,9)}`;
}

export type LoanStatus =
  | "Pending"
  | "Approved"
  | "Rejected"
  | "Disbursing"
  | "Repaying"
  | "Completed";

export interface LoanApplication {
  id: string;
  borrowerAddress: string;
  amount: string;
  status: LoanStatus;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

const store: Map<string, LoanApplication> = new Map();

export function createApplication(borrowerAddress: string, amount: string) {
  // validate address
  StrKey.decodeEd25519PublicKey(borrowerAddress);

  const id = makeId();
  const now = new Date().toISOString();
  const app: LoanApplication = {
    id,
    borrowerAddress,
    amount,
    status: "Pending",
    createdAt: now,
    updatedAt: now,
  };
  store.set(id, app);
  return app;
}

export function getApplication(id: string) {
  return store.get(id) ?? null;
}

export function getApplicationsByBorrower(address: string) {
  const list: LoanApplication[] = [];
  for (const v of store.values()) {
    if (v.borrowerAddress === address) list.push(v);
  }
  return list;
}

export function getPendingApplications() {
  return Array.from(store.values()).filter((a) => a.status === "Pending");
}

export function listApplications() {
  return Array.from(store.values());
}

export function updateApplication(id: string, patch: Partial<LoanApplication>) {
  const existing = store.get(id);
  if (!existing) return null;
  const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() } as LoanApplication;
  store.set(id, updated);
  return updated;
}

// Simple escrow check: for demo purposes consider escrow "met" when requested amount is <= 5000
export function escrowTargetMetForAmount(amount: string) {
  const num = Number(amount);
  if (Number.isNaN(num) || num <= 0) return false;
  return num <= 5000;
}
