"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid } from "recharts";
import { Info, Zap, AlertTriangle, ShieldCheck } from "lucide-react";

const Navbar = dynamic(() => import("../../components/Navbar"), { ssr: false });

type FeeRecommendation = {
  low: number;
  medium: number;
  high: number;
  latestLedger: number;
  updatedAt: number;
  isFallback: boolean;
};

type InteractionType = "deposit" | "withdraw" | "borrow" | "repay" | "vote" | "proposal";

const INTERACTION_MULTIPLIERS: Record<InteractionType, number> = {
  deposit: 1.5,
  withdraw: 1.8,
  borrow: 2.0,
  repay: 1.6,
  vote: 1.2,
  proposal: 3.5,
};

const INTERACTION_TIPS: Record<InteractionType, { title: string; tips: string[] }> = {
  deposit: {
    title: "Deposit Optimization",
    tips: [
      "Deposits require moderate computation. Use the 'Medium' fee tier for reliable inclusion.",
      "Consider batching multiple small deposits into one transaction to save on base fees.",
    ],
  },
  withdraw: {
    title: "Withdrawal Optimization",
    tips: [
      "Withdrawals involve penalty checks and time-lock reads.",
      "If withdrawing near a lockup boundary, use 'High' to ensure it lands before a penalty applies.",
    ],
  },
  borrow: {
    title: "Borrow Optimization",
    tips: [
      "Borrowing requires collateral verification and updates multiple states.",
      "Expect higher fees; use 'Medium' or 'High' based on network congestion.",
    ],
  },
  repay: {
    title: "Repayment Optimization",
    tips: [
      "Repayments are straightforward but update pool balances.",
      "Use 'Low' or 'Medium' if not approaching a loan default deadline.",
    ],
  },
  vote: {
    title: "Voting Optimization",
    tips: [
      "Voting is highly lightweight. 'Low' fee tier is almost always sufficient unless network is extremely congested.",
      "To save footprint size, vote early before the deadline.",
    ],
  },
  proposal: {
    title: "Proposal Optimization",
    tips: [
      "Creating a proposal writes a lot of data (title, description, CIDs).",
      "Keep text descriptions concise and use IPFS for detailed specs to minimize on-chain footprint size.",
    ],
  },
};

export default function GasOptimizationPage() {
  const [fees, setFees] = useState<FeeRecommendation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [interactionType, setInteractionType] = useState<InteractionType>("deposit");

  useEffect(() => {
    const fetchFees = async () => {
      try {
        const res = await fetch("http://localhost:4000/api/analytics/gas");
        if (!res.ok) throw new Error("Failed to fetch gas metrics");
        const data = await res.json();
        setFees(data);
      } catch (err: any) {
        setError(err?.message || "Failed to load gas projections");
      } finally {
        setLoading(false);
      }
    };
    
    fetchFees();
    // Refresh every 10 seconds
    const interval = setInterval(fetchFees, 10000);
    return () => clearInterval(interval);
  }, []);

  const multiplier = INTERACTION_MULTIPLIERS[interactionType];
  const chartData = fees
    ? [
        { name: "Low", stroops: Math.round(fees.low * multiplier), color: "#10b981", description: "Slower confirmation" },
        { name: "Medium", stroops: Math.round(fees.medium * multiplier), color: "#0ea5e9", description: "Standard confirmation" },
        { name: "High", stroops: Math.round(fees.high * multiplier), color: "#f43f5e", description: "Fast/Urgent confirmation" },
      ]
    : [];

  const formatStroops = (val: number) => `${val.toLocaleString()} stroops`;

  return (
    <div className="rm-app-page min-h-screen bg-[#060913] text-slate-200 selection:bg-cyan-500/30 font-sans">
      <Navbar />
      
      <main className="pt-28 pb-20 px-6 max-w-7xl mx-auto">
        <header className="mb-10 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-xs font-bold uppercase tracking-wider mb-4">
            <Zap className="w-4 h-4" /> Network Metrics
          </div>
          <h1 className="text-3xl md:text-5xl font-extrabold text-white mb-4 tracking-tight">
            Gas Estimation & Optimization
          </h1>
          <p className="text-slate-400 max-w-2xl mx-auto text-sm leading-relaxed">
            Monitor live Soroban network fees and optimize your transaction footprint. 
            Select an interaction type to see tailored footprint reduction tips.
          </p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Main Chart Section */}
          <div className="lg:col-span-2 space-y-8">
            <section className="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl relative overflow-hidden">
              <div className="absolute top-0 right-0 w-64 h-64 bg-cyan-500/10 rounded-full blur-[100px] pointer-events-none" />
              
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-8 gap-4">
                <div>
                  <h2 className="text-xl font-bold text-white mb-1">Live Fee Projections</h2>
                  <p className="text-slate-400 text-xs flex items-center gap-2">
                    {fees?.isFallback ? (
                      <span className="text-amber-400 flex items-center gap-1"><AlertTriangle className="w-3 h-3"/> Using fallback estimates</span>
                    ) : (
                      <span className="text-emerald-400 flex items-center gap-1"><ShieldCheck className="w-3 h-3"/> Network synced</span>
                    )}
                    {fees?.updatedAt && `• Last updated: ${new Date(fees.updatedAt).toLocaleTimeString()}`}
                  </p>
                </div>
                
                <div className="flex items-center gap-3">
                  <label className="text-xs font-bold uppercase text-slate-500 tracking-wider">Interaction:</label>
                  <select
                    value={interactionType}
                    onChange={(e) => setInteractionType(e.target.value as InteractionType)}
                    className="bg-slate-950 border border-slate-700 text-white text-sm rounded-xl px-4 py-2 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all font-medium"
                  >
                    <option value="deposit">Deposit</option>
                    <option value="withdraw">Withdraw</option>
                    <option value="borrow">Borrow</option>
                    <option value="repay">Repay</option>
                    <option value="vote">Vote</option>
                    <option value="proposal">Create Proposal</option>
                  </select>
                </div>
              </div>

              {loading ? (
                <div className="h-[300px] flex items-center justify-center">
                  <div className="w-8 h-8 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin" />
                </div>
              ) : error ? (
                <div className="h-[300px] flex items-center justify-center text-red-400 bg-red-500/10 rounded-2xl border border-red-500/20">
                  {error}
                </div>
              ) : (
                <div className="h-[350px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 20, right: 20, left: 20, bottom: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                      <XAxis dataKey="name" stroke="#64748b" tick={{fill: '#94a3b8'}} axisLine={false} tickLine={false} />
                      <YAxis stroke="#64748b" tick={{fill: '#94a3b8'}} axisLine={false} tickLine={false} tickFormatter={(value) => `${value}`} />
                      <Tooltip 
                        cursor={{fill: 'rgba(255,255,255,0.02)'}}
                        content={({ active, payload }) => {
                          if (active && payload && payload.length) {
                            const data = payload[0].payload;
                            return (
                              <div className="bg-slate-900 border border-slate-700 p-4 rounded-xl shadow-xl">
                                <p className="font-bold text-white mb-1">{data.name} Tier</p>
                                <p className="text-cyan-400 font-mono font-bold text-lg mb-2">{data.stroops.toLocaleString()} stroops</p>
                                <p className="text-slate-400 text-xs">{data.description}</p>
                              </div>
                            );
                          }
                          return null;
                        }}
                      />
                      <Bar dataKey="stroops" radius={[6, 6, 0, 0]} maxBarSize={80}>
                        {chartData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </section>
          </div>

          {/* Tips Section */}
          <div className="lg:col-span-1 space-y-6">
            <section className="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl h-full flex flex-col">
              <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-6 border-b border-slate-800 pb-4">
                <Info className="w-5 h-5 text-cyan-400" />
                Footprint Optimization
              </h3>
              
              <div className="flex-1 space-y-6">
                <div>
                  <h4 className="text-sm font-bold text-cyan-400 mb-3 uppercase tracking-wider">
                    {INTERACTION_TIPS[interactionType].title}
                  </h4>
                  <ul className="space-y-4">
                    {INTERACTION_TIPS[interactionType].tips.map((tip, idx) => (
                      <li key={idx} className="flex gap-3 text-sm text-slate-300 bg-slate-950/50 p-4 rounded-2xl border border-slate-800/50">
                        <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full mt-1.5 shrink-0" />
                        <span className="leading-relaxed">{tip}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                
                <div className="mt-8 p-5 bg-gradient-to-br from-indigo-500/10 to-purple-500/10 rounded-2xl border border-indigo-500/20">
                  <h4 className="font-bold text-white mb-2 text-sm">General Guidelines</h4>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Soroban charges for state access, computation, and transaction size. 
                    Minimize string usage in contract parameters and prefer smaller data types like `u32` where possible.
                  </p>
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
