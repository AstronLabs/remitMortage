"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import dynamic from "next/dynamic";
import { OptionalWalletProvider } from "@/context/WalletContext";
import { OptionalToastProvider } from "@/context/ToastContext";

const Navbar = dynamic(() => import("../../components/Navbar"), { ssr: false });
const MilestoneCard = dynamic(() => import("../../components/MilestoneCard"), { ssr: false });
const BuilderReputationTable = dynamic(
  () => import("../../components/BuilderReputationTable"),
  { ssr: false }
);

const MILESTONES = [
  { id: "m1", name: "Foundation", initialStage: "Pending" as const },
  { id: "m2", name: "Structure", initialStage: "Pending" as const },
  { id: "m3", name: "Roofing", initialStage: "Pending" as const },
  { id: "m4", name: "Finishing", initialStage: "Pending" as const },
];

export default function ContractorDashboard() {
  return (
    <OptionalToastProvider>
      <OptionalWalletProvider>
        <ContractorDashboardInner />
      </OptionalWalletProvider>
    </OptionalToastProvider>
  );
}

function ContractorDashboardInner() {
  return (
    <main className="rm-app-page rm-contractor-page min-h-screen bg-[#060913] text-slate-100 pb-20">
      <Navbar />

      <div className="rm-contractor-shell pt-32 px-6 max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-10">
          <div>
            <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-cyan-500/10 text-cyan-400 text-xs font-semibold uppercase tracking-wider mb-4 border border-cyan-500/20">
              Soroban Milestone Disbursement Hub
            </span>
            <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight text-white mb-2">
              Contractor Portal
            </h1>
            <p className="text-slate-400 text-sm md:text-base max-w-2xl">
              Upload construction inspection evidence to IPFS, request disbursement approvals, and
              track multisig voting status.
            </p>
          </div>
          <div>
            <a
              href="/contractor/payouts"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-bold shadow-lg shadow-cyan-500/20 transition"
            >
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Payout History & Tax Statements →
            </a>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {MILESTONES.map((milestone) => (
            <MilestoneCard
              key={milestone.id}
              id={milestone.id}
              name={milestone.name}
              initialStage={milestone.initialStage}
            />
          ))}
        </div>

        <BuilderReputationTable />
      </div>
    </main>
  );
}
