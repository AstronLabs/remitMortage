// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  castVote,
  createMockProposal,
  getMockSigningStatus,
  GOVERNANCE_SIGNERS,
  _resetMilestoneSigningStore,
} from "../milestoneSigningStore";

describe("milestone signing concurrency races", () => {
  beforeEach(() => {
    _resetMilestoneSigningStore();
  });

  it("concurrent approvals reaching quorum result in exactly one Passed state", async () => {
    const proposal = createMockProposal("m-concurrent-1", "bafyConcurrent1");

    const pendingSigners = GOVERNANCE_SIGNERS.map((s) => s.address);
    const results = await Promise.all(pendingSigners.map((addr) => castVote(proposal.proposalId, addr)));

    // Voting closes once quorum is reached: signers processed before closure
    // succeed, later ones in the same batch are cleanly rejected — never lost,
    // corrupted, or double-applied.
    const successful = results.filter(Boolean);
    expect(successful.length).toBeGreaterThanOrEqual(2);
    expect(successful.length).toBeLessThan(pendingSigners.length);

    const final = getMockSigningStatus(proposal.proposalId);
    expect(final?.status).toBe("Passed");
    expect(final?.currentWeight).toBeGreaterThanOrEqual(final?.requiredWeight ?? 0);

    const approvedCount = final?.signers.filter((s) => s.status === "approved").length ?? 0;
    expect(approvedCount).toBe(successful.length);
  });

  it("duplicate concurrent votes from the same signer do not double-count weight", async () => {
    const proposal = createMockProposal("m-concurrent-2", "bafyConcurrent2");
    const lead = GOVERNANCE_SIGNERS[0].address;

    const [first, second, third] = await Promise.all([
      castVote(proposal.proposalId, lead),
      castVote(proposal.proposalId, lead),
      castVote(proposal.proposalId, lead),
    ]);

    const successes = [first, second, third].filter(Boolean);
    expect(successes).toHaveLength(1);

    const final = getMockSigningStatus(proposal.proposalId);
    expect(final?.currentWeight).toBe(GOVERNANCE_SIGNERS[0].weight);
    expect(final?.status).toBe("Open");
  });

  it("interleaved approve sequences from different signers preserve vote integrity", async () => {
    const proposal = createMockProposal("m-concurrent-3", "bafyConcurrent3");
    const legal = GOVERNANCE_SIGNERS.find((s) => s.label === "Legal Review")!.address;
    const finance = GOVERNANCE_SIGNERS.find((s) => s.label === "Finance Board")!.address;
    const lead = GOVERNANCE_SIGNERS.find((s) => s.label === "Committee Lead")!.address;

    expect(castVote(proposal.proposalId, legal)).not.toBeNull();
    let status = getMockSigningStatus(proposal.proposalId);
    expect(status?.status).toBe("Open");
    expect(status?.currentWeight).toBe(1);

    expect(castVote(proposal.proposalId, lead)).not.toBeNull();
    status = getMockSigningStatus(proposal.proposalId);
    expect(status?.status).toBe("Passed");
    expect(status?.currentWeight).toBe(3);

    // Late finance vote must not change an already-passed proposal.
    expect(castVote(proposal.proposalId, finance)).toBeNull();
    status = getMockSigningStatus(proposal.proposalId);
    expect(status?.currentWeight).toBe(3);
    expect(status?.signers.find((s) => s.address === finance)?.status).toBe("pending");
  });
});
