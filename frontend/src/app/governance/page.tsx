'use client';

import React, { useState, useEffect } from 'react';
import { ShieldAlert, CheckCircle2, Clock, Check, Eye } from 'lucide-react';
import { QuorumProgressBar } from '../../components/governance/QuorumProgressBar';
import { EvidenceDrawer } from '../../components/governance/EvidenceDrawer';
import { MultisigApprovalCard, type GovernanceSigner } from '../../components/governance/MultisigApprovalCard';

// Mock toast notification
const toast = {
  success: (msg: string) => console.log('Toast success:', msg),
  error: (msg: string) => console.error('Toast error:', msg)
};

// Mock Hook for Access Control
const useCommitteeMember = () => {
  const [isMember, setIsMember] = useState<boolean | null>(null);
  
  useEffect(() => {
    // Simulate checking wallet status/contract connection
    const timer = setTimeout(() => setIsMember(true), 1200);
    return () => clearTimeout(timer);
  }, []);

  return { isMember };
};

const mockSigners: GovernanceSigner[] = [
  { address: 'GABC1234567890XYZABC1234567890XYZABC1234567890', label: 'Committee Lead', weight: 2, status: 'approved' },
  { address: 'GDEF1234567890XYZDEF1234567890XYZDEF1234567890', label: 'Legal Review', weight: 1, status: 'approved' },
  { address: 'GHIJ1234567890XYZGHIJ1234567890XYZGHIJ1234567890', label: 'Finance Board', weight: 1, status: 'pending' },
];

const mockApprovalProposals = [
  {
    id: 'approval_1',
    milestoneTitle: 'Phase 1: Foundation & Grading',
    contractor: 'BuildWell Construction LLC',
    amount: '50,000 USDC',
    ipfsCid: 'QmTestHash12345abcdef',
    currentWeight: 3,
    requiredWeight: 3,
    totalSignerWeight: 4,
    signers: mockSigners,
    status: 'approved' as const,
    expiration: '2 days',
  },
  {
    id: 'approval_2',
    milestoneTitle: 'Phase 2: Framing & Structural Work',
    contractor: 'Structo Builders Inc.',
    amount: '120,000 USDC',
    ipfsCid: 'QmAnotherHash987654abcdef',
    currentWeight: 2,
    requiredWeight: 3,
    totalSignerWeight: 4,
    signers: mockSigners.map((s, i) => ({
      ...s,
      status: i === 0 ? ('approved' as const) : i === 1 ? ('approved' as const) : ('pending' as const),
    })),
    status: 'pending' as const,
    expiration: '5 days',
  },
];

// Mock data for proposals
const mockProposals = [
  {
    id: 'prop_1',
    title: 'Phase 1: Foundation & Grading',
    contractor: 'BuildWell Construction LLC',
    amount: '50,000 USDC',
    expiration: '2 days',
    currentVotes: 2,
    requiredVotes: 3,
    quorumPercent: 60,
    status: 'pending',
    ipfsCid: 'QmTestHash12345/image.png'
  },
  {
    id: 'prop_2',
    title: 'Phase 2: Framing & Structural',
    contractor: 'Structo Builders',
    amount: '120,000 USDC',
    expiration: '5 days',
    currentVotes: 3,
    requiredVotes: 3,
    quorumPercent: 60,
    status: 'approved',
    ipfsCid: 'QmAnotherHash/video.mp4'
  }
];

export default function GovernanceDashboard() {
  const { isMember } = useCommitteeMember();
  const [proposals, setProposals] = useState(mockProposals);
  const [approvalProposals, setApprovalProposals] = useState(mockApprovalProposals);
  const [selectedEvidenceCid, setSelectedEvidenceCid] = useState<string | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isVoting, setIsVoting] = useState<string | null>(null);

  if (isMember === null) {
    return (
      <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center p-6">
        <div className="relative">
          <div className="w-16 h-16 border-4 border-zinc-800 border-t-cyan-500 rounded-full animate-spin"></div>
          <div className="absolute inset-0 border-4 border-transparent border-l-emerald-500 rounded-full animate-spin animation-delay-200 opacity-50"></div>
        </div>
        <p className="mt-6 text-zinc-400 font-medium tracking-wide animate-pulse">Checking committee credentials...</p>
      </div>
    );
  }

  if (isMember === false) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-zinc-900 border border-zinc-800 rounded-2xl p-8 text-center shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-red-500"></div>
          <div className="mx-auto w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center mb-6">
            <ShieldAlert className="w-10 h-10 text-red-500 drop-shadow-[0_0_10px_rgba(239,68,68,0.5)]" />
          </div>
          <h1 className="text-2xl font-bold text-zinc-100 mb-3 tracking-tight">Access Denied</h1>
          <p className="text-zinc-400 mb-8 leading-relaxed text-sm">
            Your connected wallet is not registered as a committee member for this Soroban governance module.
          </p>
          <button className="w-full py-3.5 px-4 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-semibold rounded-xl transition-all shadow-md hover:shadow-lg border border-zinc-700/50 hover:border-zinc-600">
            Return to Home
          </button>
        </div>
      </div>
    );
  }

  const handleVote = async (proposalId: string) => {
    setIsVoting(proposalId);
    try {
      // Mock Soroban smart contract interaction via Freighter wallet
      await new Promise(resolve => setTimeout(resolve, 2500));
      
      toast.success('Vote successfully cast and recorded on-chain.');
      
      // Update UI state
      setProposals(prev => prev.map(p => {
        if (p.id === proposalId) {
          const newVotes = p.currentVotes + 1;
          return {
            ...p,
            currentVotes: newVotes,
            status: newVotes >= p.requiredVotes ? 'approved' : 'pending'
          };
        }
        return p;
      }));
    } catch (error) {
      toast.error('Failed to cast vote. Transaction rejected.');
    } finally {
      setIsVoting(null);
    }
  };

  const openEvidence = (cid: string) => {
    setSelectedEvidenceCid(cid);
    setIsDrawerOpen(true);
  };

  const handleApprovalVote = async (proposalId: string) => {
    setIsVoting(proposalId);
    try {
      await new Promise(resolve => setTimeout(resolve, 2500));
      toast.success('Vote successfully cast and recorded on-chain.');
      setApprovalProposals(prev => prev.map(p => {
        if (p.id !== proposalId) return p;
        const newWeight = p.currentWeight + 1;
        return {
          ...p,
          currentWeight: newWeight,
          status: newWeight >= p.requiredWeight ? ('approved' as const) : ('pending' as const),
          signers: p.signers.map((s, i) =>
            i === p.signers.findIndex(sig => sig.status === 'pending')
              ? { ...s, status: 'approved' as const }
              : s
          ),
        };
      }));
    } catch {
      toast.error('Failed to cast vote. Transaction rejected.');
    } finally {
      setIsVoting(null);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6 md:p-10 font-sans selection:bg-cyan-500/30 selection:text-cyan-100">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-12 space-y-6 md:space-y-0">
          <div>
            <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-white mb-2">
              Signer Dashboard
            </h1>
            <p className="text-zinc-400 text-sm md:text-base font-medium">
              Review milestone evidence and cast multisig governance votes.
            </p>
          </div>
          <div className="flex items-center space-x-2.5 bg-emerald-500/10 border border-emerald-500/20 px-5 py-2.5 rounded-full shadow-[0_0_15px_rgba(16,185,129,0.1)]">
            <CheckCircle2 className="w-5 h-5 text-emerald-500" />
            <span className="text-emerald-400 font-semibold text-sm tracking-wide">Committee Active</span>
          </div>
        </div>

        {/* Multisig Approval Cards — #154 */}
        <section className="mb-12">
          <h2 className="text-xl font-bold text-zinc-100 mb-1">Approval Requests</h2>
          <p className="text-zinc-400 text-sm mb-6">
            Review milestone evidence and cast your weighted vote toward quorum.
          </p>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {approvalProposals.map(proposal => (
              <MultisigApprovalCard
                key={proposal.id}
                {...proposal}
                onVote={handleApprovalVote}
                isVoting={isVoting === proposal.id}
              />
            ))}
          </div>
        </section>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
          {proposals.map(proposal => (
            <div 
              key={proposal.id} 
              className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 sm:p-8 shadow-xl flex flex-col transition-all duration-300 hover:border-zinc-700/80 hover:shadow-2xl hover:shadow-cyan-900/10 group"
            >
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 space-y-4 sm:space-y-0">
                <div>
                  <h3 className="text-xl font-bold text-zinc-100 mb-1.5 group-hover:text-cyan-400 transition-colors">{proposal.title}</h3>
                  <p className="text-zinc-500 text-sm font-medium">Proposed by <span className="text-zinc-300">{proposal.contractor}</span></p>
                </div>
                <div className={`px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-widest shrink-0 ${
                  proposal.status === 'approved' 
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-[0_0_10px_rgba(16,185,129,0.1)]'
                    : 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shadow-[0_0_10px_rgba(6,182,212,0.1)]'
                }`}>
                  {proposal.status}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-8">
                <div className="bg-zinc-950 p-5 rounded-xl border border-zinc-800/80 shadow-inner">
                  <span className="block text-zinc-500 text-xs font-bold uppercase tracking-wider mb-2">Requested Amount</span>
                  <span className="text-xl font-extrabold text-zinc-100">{proposal.amount}</span>
                </div>
                <div className="bg-zinc-950 p-5 rounded-xl border border-zinc-800/80 shadow-inner">
                  <span className="block text-zinc-500 text-xs font-bold uppercase tracking-wider mb-2">Expires In</span>
                  <div className="flex items-center text-zinc-300 font-semibold text-lg">
                    <Clock className="w-5 h-5 mr-2 text-zinc-500" />
                    {proposal.expiration}
                  </div>
                </div>
              </div>

              <div className="mb-8">
                <QuorumProgressBar 
                  currentVotes={proposal.currentVotes} 
                  requiredVotes={proposal.requiredVotes} 
                  quorumThresholdPercent={proposal.quorumPercent} 
                />
              </div>

              <div className="mt-auto flex flex-col sm:flex-row gap-4 pt-4 border-t border-zinc-800/50">
                <button
                  onClick={() => openEvidence(proposal.ipfsCid)}
                  className="flex-1 flex items-center justify-center py-3.5 px-4 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-semibold rounded-xl transition-colors border border-zinc-700 hover:border-zinc-500 shadow-sm"
                >
                  <Eye className="w-5 h-5 mr-2 text-zinc-400" />
                  View Evidence
                </button>
                <button
                  onClick={() => handleVote(proposal.id)}
                  disabled={proposal.status === 'approved' || isVoting === proposal.id}
                  className={`flex-1 flex items-center justify-center py-3.5 px-4 font-bold rounded-xl transition-all duration-300 ${
                    proposal.status === 'approved'
                      ? 'bg-zinc-800/50 text-zinc-500 border border-zinc-800 cursor-not-allowed'
                      : isVoting === proposal.id
                        ? 'bg-cyan-600/50 text-cyan-100 cursor-wait border border-cyan-500/50'
                        : 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-[0_0_15px_rgba(6,182,212,0.3)] hover:shadow-[0_0_20px_rgba(6,182,212,0.5)] border border-cyan-500 hover:scale-[1.02]'
                  }`}
                >
                  {proposal.status === 'approved' ? (
                    <>
                      <Check className="w-5 h-5 mr-2" />
                      Approved
                    </>
                  ) : isVoting === proposal.id ? (
                    <>
                      <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2" />
                      Signing...
                    </>
                  ) : (
                    'Approve Proposal'
                  )}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <EvidenceDrawer 
        isOpen={isDrawerOpen} 
        onClose={() => setIsDrawerOpen(false)} 
        ipfsCid={selectedEvidenceCid || ''} 
      />
    </div>
  );
}
