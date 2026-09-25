// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useState, useCallback, useEffect } from "react";
import { useWallet } from "../context/WalletContext";

export interface GovernanceProposal {
  id: string;
  title: string;
  description: string;
  amount?: string;
  status: "pending" | "approved" | "rejected" | "executed";
  expiration: string;
  currentVotes: number;
  requiredVotes: number;
  quorumPercent: number;
  ipfsCid?: string;
}

const mockProposals: GovernanceProposal[] = [
  {
    id: "gov_1",
    title: "Update Pool Liquidity Ratio",
    description: "Adjust the minimum senior liquidity requirement from 70% to 65% to allow more junior capital utilization.",
    status: "pending",
    expiration: "3 days",
    currentVotes: 4200,
    requiredVotes: 5000,
    quorumPercent: 65,
  },
  {
    id: "gov_2",
    title: "Approve New Construction Validator",
    description: "Add 'BuildTrust Auditors' to the multisig committee for verifying milestone completions in the NorthEast region.",
    status: "pending",
    expiration: "5 days",
    currentVotes: 1200,
    requiredVotes: 8000,
    quorumPercent: 40,
    ipfsCid: "QmHash123ValidatorCredentials",
  },
];

export function useGovernanceProposals() {
  const { isConnected } = useWallet();
  const [proposals, setProposals] = useState<GovernanceProposal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProposals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Simulate network request to Governance contract or backend indexer
      await new Promise((resolve) => setTimeout(resolve, 800));
      setProposals(mockProposals);
    } catch (err: any) {
      setError(err?.message || "Failed to load proposals");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProposals();
  }, [loadProposals]);

  const submitVote = async (proposalId: string, vote: "yes" | "no" | "abstain") => {
    if (!isConnected) throw new Error("Wallet not connected");
    // Simulate transaction
    await new Promise((resolve) => setTimeout(resolve, 2000));
    
    // Optimistic update
    setProposals((prev) =>
      prev.map((p) => {
        if (p.id === proposalId) {
          const newVotes = p.currentVotes + (vote === "yes" ? 500 : 0);
          return {
            ...p,
            currentVotes: newVotes,
            status: newVotes >= p.requiredVotes ? "approved" : p.status,
          };
        }
        return p;
      })
    );
  };

  const createProposal = async (proposalData: Partial<GovernanceProposal>) => {
    if (!isConnected) throw new Error("Wallet not connected");
    // Simulate transaction
    await new Promise((resolve) => setTimeout(resolve, 2500));
    
    const newProposal: GovernanceProposal = {
      id: `gov_${Date.now()}`,
      title: proposalData.title || "Untitled",
      description: proposalData.description || "",
      amount: proposalData.amount,
      status: "pending",
      expiration: "7 days",
      currentVotes: 0,
      requiredVotes: 10000,
      quorumPercent: 0,
      ipfsCid: proposalData.ipfsCid,
    };

    setProposals((prev) => [newProposal, ...prev]);
  };

  return {
    proposals,
    loading,
    error,
    submitVote,
    createProposal,
    refresh: loadProposals,
  };
}
