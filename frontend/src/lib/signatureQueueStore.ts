"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type SignerStatus = "pending" | "approved";

export interface CachedSigner {
  address: string;
  label: string;
  weight: number;
  status: SignerStatus;
}

export interface CachedProposal {
  proposalId: string;
  milestoneId: string;
  evidenceCid: string;
  signers: CachedSigner[];
  requiredWeight: number;
  totalWeight: number;
  currentWeight: number;
  status: "Open" | "Passed";
  transactionEnvelope: string;
  createdAt: string;
  updatedAt: string;
}

interface SignatureQueueState {
  proposals: Record<string, CachedProposal>;
  addProposal: (
    proposalId: string,
    milestoneId: string,
    evidenceCid: string,
    signers: Array<{ address: string; label: string; weight: number }>,
    requiredWeight: number
  ) => void;
  recordSignature: (
    proposalId: string,
    signerAddress: string,
    signedEnvelopeXdr: string
  ) => CachedProposal | null;
  getProposal: (proposalId: string) => CachedProposal | null;
  getNextPendingSigner: (proposalId: string) => CachedSigner | null;
  getCurrentQueueOrder: (proposalId: string) => CachedSigner[];
  removeProposal: (proposalId: string) => void;
}

export const useSignatureQueueStore = create<SignatureQueueState>()(
  persist(
    (set, get) => ({
      proposals: {},

      addProposal: (proposalId, milestoneId, evidenceCid, signers, requiredWeight) => {
        const totalWeight = signers.reduce((sum, s) => sum + s.weight, 0);
        const now = new Date().toISOString();
        const proposal: CachedProposal = {
          proposalId,
          milestoneId,
          evidenceCid,
          signers: signers.map((s) => ({ ...s, status: "pending" as const })),
          requiredWeight,
          totalWeight,
          currentWeight: 0,
          status: "Open",
          transactionEnvelope: `envelope:${proposalId}:base`,
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({
          proposals: { ...state.proposals, [proposalId]: proposal },
        }));
      },

      recordSignature: (proposalId, signerAddress, signedEnvelopeXdr) => {
        const proposal = get().proposals[proposalId];
        if (!proposal || proposal.status !== "Open") return null;

        const signer = proposal.signers.find(
          (s) => s.address === signerAddress && s.status === "pending"
        );
        if (!signer) return null;

        const updatedSigners = proposal.signers.map((s) =>
          s.address === signerAddress ? { ...s, status: "approved" as const } : s
        );

        const newWeight = proposal.currentWeight + signer.weight;
        const isPassed = newWeight >= proposal.requiredWeight;

        const updated: CachedProposal = {
          ...proposal,
          signers: updatedSigners,
          currentWeight: newWeight,
          status: isPassed ? "Passed" : "Open",
          transactionEnvelope: `envelope:${proposalId}:${isPassed ? "fully-signed" : signedEnvelopeXdr}`,
          updatedAt: new Date().toISOString(),
        };

        set((state) => ({
          proposals: { ...state.proposals, [proposalId]: updated },
        }));

        return updated;
      },

      getProposal: (proposalId) => get().proposals[proposalId] ?? null,

      getNextPendingSigner: (proposalId) => {
        const proposal = get().proposals[proposalId];
        if (!proposal || proposal.status === "Passed") return null;
        return proposal.signers.find((s) => s.status === "pending") ?? null;
      },

      getCurrentQueueOrder: (proposalId) => {
        const proposal = get().proposals[proposalId];
        if (!proposal) return [];
        return [...proposal.signers];
      },

      removeProposal: (proposalId) => {
        set((state) => {
          const { [proposalId]: _, ...rest } = state.proposals;
          return { proposals: rest };
        });
      },
    }),
    {
      name: "remitmortage-signature-queue",
      partialize: (state) => ({
        proposals: state.proposals,
      }),
    }
  )
);
