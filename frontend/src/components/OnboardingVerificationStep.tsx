"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState } from "react";
import { MultiWalletModal } from "./MultiWalletModal";
import { ShieldCheck, ArrowRight } from "lucide-react";

export const OnboardingVerificationStep: React.FC = () => {
  const [isWalletModalOpen, setIsWalletModalOpen] = useState(false);
  const [verificationData, setVerificationData] = useState<{
    address: string;
    chainType: string;
  } | null>(null);

  const handleVerificationComplete = (address: string, chainType: string, signature: string) => {
    // Save verification state to onboarding context
    console.log("Identity verified:", { address, chainType, signature });
    setVerificationData({ address, chainType });

    // Close the modal and proceed
    setTimeout(() => setIsWalletModalOpen(false), 2000);
  };

  return (
    <div className="w-full max-w-2xl mx-auto p-8 bg-zinc-950 border border-zinc-800 rounded-2xl shadow-xl">
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-zinc-100 mb-2">Proof of Ownership</h2>
        <p className="text-zinc-400">
          To comply with our anti-fraud protocols, please prove you control the wallet that sent the
          initial remittances.
        </p>
      </div>

      {!verificationData ? (
        <div className="flex flex-col items-center justify-center p-8 border-2 border-dashed border-zinc-800 rounded-xl bg-zinc-900/50">
          <div className="w-16 h-16 bg-indigo-500/10 rounded-full flex items-center justify-center mb-4">
            <ShieldCheck className="w-8 h-8 text-indigo-400" />
          </div>
          <h3 className="text-lg font-semibold text-zinc-200 mb-2">
            Identity Verification Required
          </h3>
          <p className="text-sm text-zinc-500 text-center max-w-md mb-6">
            We'll ask you to cryptographically sign a simple message. This does not cost any gas and
            does not authorize any transactions.
          </p>
          <button
            onClick={() => setIsWalletModalOpen(true)}
            className="flex items-center px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-xl transition-all shadow-lg shadow-indigo-900/20"
          >
            Connect Remittance Wallet
            <ArrowRight className="w-4 h-4 ml-2" />
          </button>
        </div>
      ) : (
        <div className="p-6 bg-emerald-500/10 border border-emerald-500/20 rounded-xl">
          <div className="flex items-center mb-4">
            <div className="w-10 h-10 bg-emerald-500/20 rounded-full flex items-center justify-center mr-4">
              <ShieldCheck className="w-5 h-5 text-emerald-400" />
            </div>
            <div>
              <h3 className="text-emerald-400 font-bold text-lg">Identity Verified</h3>
              <p className="text-zinc-400 text-sm">
                Connected with {verificationData.chainType === "evm" ? "Ethereum" : "Solana"} (
                {verificationData.address.slice(0, 6)}...{verificationData.address.slice(-4)})
              </p>
            </div>
          </div>
          <button className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl transition-colors">
            Continue to Next Step
          </button>
        </div>
      )}

      <MultiWalletModal
        isOpen={isWalletModalOpen}
        onClose={() => setIsWalletModalOpen(false)}
        onVerificationComplete={handleVerificationComplete}
      />
    </div>
  );
};
