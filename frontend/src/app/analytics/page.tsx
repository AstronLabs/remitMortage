/* eslint-disable react-hooks/set-state-in-effect */
"use client"

import React, { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell
} from "recharts";

const Navbar = dynamic(() => import("../../components/Navbar"), { ssr: false });

// ── Animated Counter Component ──────────────────────────────────────────
function AnimatedCounter({ value, prefix = "", suffix = "" }: { value: number; prefix?: string; suffix?: string }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let start = 0;
    const end = value;
    if (start === end) {
      setCount(end);
      return;
    }

    const duration = 800; // 0.8s
    const stepTime = 15;
    const steps = duration / stepTime;
    const increment = Math.ceil(end / steps);

    const timer = setInterval(() => {
      start += increment;
      if (start >= end) {
        clearInterval(timer);
        setCount(end);
      } else {
        setCount(start);
      }
    }, stepTime);

    return () => clearInterval(timer);
  }, [value]);

  return <span>{prefix}{count.toLocaleString()}{suffix}</span>;
}

// ── Types ──────────────────────────────────────────────────────────────
interface OverviewData {
  totalValueLocked: number;
  activeBorrowers: number;
  activeInvestors: number;
  loansDisbursed: number;
  recentActivity: Array<{
    id: string;
    type: string;
    amount: string;
    address: string;
    timestamp: string;
  }>;
}

interface LoanPerformanceData {
  name: string;
  value: number;
  color: string;
}

interface VolumeData {
  month: string;
  deposits: number;
  repayments: number;
  disbursements: number;
}

export default function AnalyticsPage() {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [loanPerformance, setLoanPerformance] = useState<LoanPerformanceData[]>([]);
  const [volumeData, setVolumeData] = useState<VolumeData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);

    async function fetchData() {
      try {
        setLoading(true);
        setError(null);

        // Call GET /api/analytics/overview, /api/loans, and /api/volume?months=12 concurrently
        const [overviewRes, loansRes, volumeRes] = await Promise.all([
          fetch("/api/analytics/overview"),
          fetch("/api/loans"),
          fetch("/api/volume?months=12")
        ]);

        if (!overviewRes.ok || !loansRes.ok || !volumeRes.ok) {
          throw new Error("One or more analytics API fetches failed.");
        }

        const [overviewData, loansData, volumeData] = await Promise.all([
          overviewRes.json(),
          loansRes.json(),
          volumeRes.json()
        ]);

        setOverview(overviewData);
        setLoanPerformance(loansData);
        setVolumeData(volumeData);
      } catch (err) {
        console.error("Error loading analytics data:", err);
        setError(err instanceof Error ? err.message : "Failed to load protocol analytics.");
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, []);

  return (
    <div>
      <Navbar />

      <main className="max-w-7xl mx-auto px-6 pt-28 pb-20">
        {/* Header */}
        <div className="mb-10 text-center md:text-left">
          <h1 className="text-4xl font-bold tracking-tight mb-2 gradient-text">
            Protocol Analytics
          </h1>
          <p className="text-[var(--text-secondary)] text-lg max-w-2xl">
            Real-time transparency metrics for the RemitMortgage lending pools, borrow activity, and stablecoin flows.
          </p>
        </div>

        {loading && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-32 bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl animate-pulse" />
            ))}
          </div>
        )}

        {error && (
          <div className="p-6 bg-red-950/40 border border-red-500/30 text-red-200 rounded-xl mb-8">
            <h3 className="font-semibold mb-2">Error Loading Dashboard</h3>
            <p className="text-sm">{error}</p>
          </div>
        )}

        {!loading && !error && overview && (
          <>
            {/* Overview Stats Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-10">
              {/* TVL */}
              <div className="glass-card p-6 flex items-center justify-between">
                <div>
                  <p className="text-sm text-[var(--text-secondary)] font-medium mb-1">Total Value Locked</p>
                  <h3 className="text-3xl font-extrabold tracking-tight text-[var(--text-primary)]">
                    <AnimatedCounter value={overview.totalValueLocked} prefix="$" />
                  </h3>
                </div>
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-500 flex items-center justify-center shadow-lg shadow-indigo-500/20">
                  <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" className="w-6 h-6">
                    <rect x="3" y="11" width="18" height="10" rx="2" />
                    <path d="M12 2v9M8 5h8" />
                  </svg>
                </div>
              </div>

              {/* Active Borrowers */}
              <div className="glass-card p-6 flex items-center justify-between">
                <div>
                  <p className="text-sm text-[var(--text-secondary)] font-medium mb-1">Active Borrowers</p>
                  <h3 className="text-3xl font-extrabold tracking-tight text-[var(--text-primary)]">
                    <AnimatedCounter value={overview.activeBorrowers} />
                  </h3>
                </div>
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-500 to-indigo-500 flex items-center justify-center shadow-lg shadow-purple-500/20">
                  <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" className="w-6 h-6">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </div>
              </div>

              {/* Active Investors */}
              <div className="glass-card p-6 flex items-center justify-between">
                <div>
                  <p className="text-sm text-[var(--text-secondary)] font-medium mb-1">Active Investors</p>
                  <h3 className="text-3xl font-extrabold tracking-tight text-[var(--text-primary)]">
                    <AnimatedCounter value={overview.activeInvestors} />
                  </h3>
                </div>
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-cyan-500 to-emerald-500 flex items-center justify-center shadow-lg shadow-cyan-500/20">
                  <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" className="w-6 h-6">
                    <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                  </svg>
                </div>
              </div>

              {/* Loans Disbursed */}
              <div className="glass-card p-6 flex items-center justify-between">
                <div>
                  <p className="text-sm text-[var(--text-secondary)] font-medium mb-1">Loans Disbursed</p>
                  <h3 className="text-3xl font-extrabold tracking-tight text-[var(--text-primary)]">
                    <AnimatedCounter value={overview.loansDisbursed} />
                  </h3>
                </div>
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center shadow-lg shadow-emerald-500/20">
                  <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" className="w-6 h-6">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                </div>
              </div>
            </div>

            {/* Charts Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-10">
              {/* Volume Area Chart */}
              <div className="glass-card p-6 lg:col-span-2 flex flex-col justify-between">
                <div className="mb-4">
                  <h3 className="text-lg font-bold text-[var(--text-primary)]">Volume Trends (USDC)</h3>
                  <p className="text-xs text-[var(--text-secondary)]">Monthly deposit, repayment, and disbursement volumes</p>
                </div>
                <div className="h-[300px] w-full">
                  {mounted && volumeData.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={volumeData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                        <defs>
                          <linearGradient id="colorDeposits" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4}/>
                            <stop offset="95%" stopColor="#6366f1" stopOpacity={0.0}/>
                          </linearGradient>
                          <linearGradient id="colorDisbursements" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.4}/>
                            <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.0}/>
                          </linearGradient>
                          <linearGradient id="colorRepayments" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#10b981" stopOpacity={0.4}/>
                            <stop offset="95%" stopColor="#10b981" stopOpacity={0.0}/>
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255, 255, 255, 0.05)" />
                        <XAxis dataKey="month" stroke="#64748b" style={{ fontSize: "11px" }} />
                        <YAxis stroke="#64748b" style={{ fontSize: "11px" }} tickFormatter={(tick) => `$${tick.toLocaleString()}`} />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "#111827",
                            borderColor: "rgba(99, 102, 241, 0.15)",
                            borderRadius: "8px",
                            color: "#f1f5f9"
                          }}
                          formatter={(value) => [`$${value.toLocaleString()}`, ""]}
                        />
                        <Area type="monotone" dataKey="deposits" name="Deposits" stroke="#6366f1" fillOpacity={1} fill="url(#colorDeposits)" strokeWidth={2} />
                        <Area type="monotone" dataKey="disbursements" name="Disbursed" stroke="#06b6d4" fillOpacity={1} fill="url(#colorDisbursements)" strokeWidth={2} />
                        <Area type="monotone" dataKey="repayments" name="Repayments" stroke="#10b981" fillOpacity={1} fill="url(#colorRepayments)" strokeWidth={2} />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="h-full flex items-center justify-center text-sm text-[var(--text-secondary)]">Loading chart...</div>
                  )}
                </div>
              </div>

              {/* Loan Performance Pie Chart */}
              <div className="glass-card p-6 flex flex-col justify-between">
                <div className="mb-2">
                  <h3 className="text-lg font-bold text-[var(--text-primary)]">Loan Performance</h3>
                  <p className="text-xs text-[var(--text-secondary)]">Distribution of active, repaid, and defaulted loans</p>
                </div>
                <div className="h-[240px] flex items-center justify-center relative">
                  {mounted && loanPerformance.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={loanPerformance}
                          cx="50%"
                          cy="50%"
                          innerRadius={65}
                          outerRadius={85}
                          paddingAngle={5}
                          dataKey="value"
                        >
                          {loanPerformance.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "#111827",
                            borderColor: "rgba(99, 102, 241, 0.15)",
                            borderRadius: "8px",
                            color: "#f1f5f9"
                          }}
                          formatter={(value) => [`${value}%`, ""]}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="text-sm text-[var(--text-secondary)]">Loading chart...</div>
                  )}
                  {/* Center Text */}
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <span className="text-2xl font-black text-[var(--text-primary)]">
                      {loanPerformance.find(d => d.name === "Active")?.value || 0}%
                    </span>
                    <span className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">Active Pool</span>
                  </div>
                </div>
                {/* Custom Legend */}
                <div className="flex justify-around text-xs border-t border-[var(--border-color)] pt-4">
                  {loanPerformance.map((item, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                      <span className="text-[var(--text-secondary)] font-medium">{item.name} ({item.value}%)</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Bottom Row - Activity Feed */}
            <div className="glass-card p-6">
              <div className="mb-6 flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-bold text-[var(--text-primary)]">Recent Activity Feed</h3>
                  <p className="text-xs text-[var(--text-secondary)]">Live ledger events representing pool interactions</p>
                </div>
                <span className="flex h-2.5 w-2.5 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                </span>
              </div>

              <div className="flow-root">
                <ul role="list" className="-mb-8">
                  {overview.recentActivity.map((activity, activityIdx) => (
                    <li key={activity.id}>
                      <div className="relative pb-8">
                        {activityIdx !== overview.recentActivity.length - 1 ? (
                          <span className="absolute top-4 left-4 -ml-px h-full w-0.5 bg-[var(--border-color)]" aria-hidden="true" />
                        ) : null}
                        <div className="relative flex space-x-3 items-center">
                          <div>
                            <span className={`h-8 w-8 rounded-lg flex items-center justify-center ring-8 ring-[var(--bg-primary)] ${
                              activity.type === "deposit"
                                ? "bg-indigo-500/10 text-indigo-400"
                                : activity.type === "approval"
                                ? "bg-purple-500/10 text-purple-400"
                                : activity.type === "disbursement"
                                ? "bg-cyan-500/10 text-cyan-400"
                                : "bg-emerald-500/10 text-emerald-400"
                            }`}>
                              {activity.type === "deposit" && (
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                                </svg>
                              )}
                              {activity.type === "approval" && (
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.746 3.746 0 011.043 3.296A3.745 3.745 0 0121 12z" />
                                </svg>
                              )}
                              {activity.type === "disbursement" && (
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 19.5l15-15m0 0H8.25m11.25 0v11.25" />
                                </svg>
                              )}
                              {activity.type === "repayment" && (
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 4.5l-15 15m0 0h11.25m-11.25 0V8.25" />
                                </svg>
                              )}
                            </span>
                          </div>
                          <div className="flex-1 min-w-0 flex justify-between gap-4">
                            <div>
                              <p className="text-sm font-semibold text-[var(--text-primary)]">
                                {activity.type.charAt(0).toUpperCase() + activity.type.slice(1)} of{" "}
                                <span className="text-[var(--accent-primary-light)] font-bold">{activity.amount}</span>
                              </p>
                              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                                Initiated by <code className="text-[var(--text-secondary)]">{activity.address}</code>
                              </p>
                            </div>
                            <div className="text-right text-xs whitespace-nowrap text-[var(--text-muted)] self-center">
                              <time dateTime={activity.timestamp}>
                                {new Date(activity.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{" "}
                                ({new Date(activity.timestamp).toLocaleDateString()})
                              </time>
                            </div>
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
