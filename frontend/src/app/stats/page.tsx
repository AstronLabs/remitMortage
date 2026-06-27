"use client"

import React, { useEffect, useState } from "react";
import dynamic from "next/dynamic";

const Navbar = dynamic(() => import("../../components/Navbar"), { ssr: false });

interface StatsData {
  totalValueLocked: number;
  activeLoanVolume: number;
  averageCreditScore: number;
  totalMilestonesCompleted: number;
  activeBorrowers: number;
  loansDisbursed: number;
  lastUpdated: string;
}

function AnimatedCounter({ value, prefix = "", suffix = "" }: { value: number; prefix?: string; suffix?: string }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let start = 0;
    const end = value;
    if (start === end) {
      setCount(end);
      return;
    }

    const duration = 800;
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

function LoadingSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
      {[...Array(4)].map((_, i) => (
        <div
          key={i}
          className="h-36 rounded-xl animate-pulse"
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border-color)",
          }}
        />
      ))}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      className="p-6 rounded-xl text-center"
      style={{
        background: "rgba(239, 68, 68, 0.1)",
        border: "1px solid rgba(239, 68, 68, 0.3)",
      }}
    >
      <h3
        className="font-semibold mb-2"
        style={{ color: "var(--error)" }}
      >
        Error Loading Stats
      </h3>
      <p className="text-sm mb-4" style={{ color: "var(--text-secondary)" }}>
        {message}
      </p>
      <button
        onClick={onRetry}
        className="btn-primary"
      >
        Retry
      </button>
    </div>
  );
}

function MetricCard({
  title,
  value,
  prefix,
  suffix,
  icon,
  gradient,
}: {
  title: string;
  value: number;
  prefix?: string;
  suffix?: string;
  icon: React.ReactNode;
  gradient: string;
}) {
  return (
    <div className="glass-card p-6 flex items-center justify-between">
      <div>
        <p
          className="text-sm font-medium mb-1"
          style={{ color: "var(--text-secondary)" }}
        >
          {title}
        </p>
        <h3
          className="text-3xl font-extrabold tracking-tight"
          style={{ color: "var(--text-primary)" }}
        >
          <AnimatedCounter value={value} prefix={prefix} suffix={suffix} />
        </h3>
      </div>
      <div
        className="w-12 h-12 rounded-xl flex items-center justify-center"
        style={{
          background: gradient,
          boxShadow: `0 4px 20px ${gradient.includes("indigo") ? "rgba(99, 102, 241, 0.2)" : gradient.includes("purple") ? "rgba(168, 85, 247, 0.2)" : gradient.includes("cyan") ? "rgba(6, 182, 212, 0.2)" : "rgba(16, 185, 129, 0.2)"}`,
        }}
      >
        {icon}
      </div>
    </div>
  );
}

export default function StatsPage() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function fetchStats() {
    try {
      setLoading(true);
      setError(null);

      const res = await fetch("/api/analytics/stats");
      if (!res.ok) throw new Error(`Failed to fetch stats: ${res.status}`);

      const data = await res.json();
      setStats(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load stats.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchStats();
  }, []);

  return (
    <div>
      <Navbar />

      <main className="max-w-7xl mx-auto px-6 pt-28 pb-20">
        <div className="mb-10 text-center md:text-left">
          <h1
            className="text-4xl font-bold tracking-tight mb-2 gradient-text"
          >
            Platform Stats
          </h1>
          <p
            className="text-lg max-w-2xl"
            style={{ color: "var(--text-secondary)" }}
          >
            Key protocol metrics for investors, borrowers, and contractors.
          </p>
        </div>

        {loading && <LoadingSkeleton />}

        {error && <ErrorState message={error} onRetry={fetchStats} />}

        {!loading && !error && stats && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-10">
              <MetricCard
                title="Total Value Locked"
                value={stats.totalValueLocked}
                prefix="$"
                gradient="linear-gradient(135deg, #6366f1, #06b6d4)"
                icon={
                  <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" className="w-6 h-6">
                    <rect x="3" y="11" width="18" height="10" rx="2" />
                    <path d="M12 2v9M8 5h8" />
                  </svg>
                }
              />

              <MetricCard
                title="Active Loan Volume"
                value={stats.activeLoanVolume}
                prefix="$"
                gradient="linear-gradient(135deg, #a855f7, #6366f1)"
                icon={
                  <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" className="w-6 h-6">
                    <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                  </svg>
                }
              />

              <MetricCard
                title="Avg Credit Score"
                value={stats.averageCreditScore}
                suffix=" pts"
                gradient="linear-gradient(135deg, #06b6d4, #10b981)"
                icon={
                  <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" className="w-6 h-6">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                }
              />

              <MetricCard
                title="Milestones Completed"
                value={stats.totalMilestonesCompleted}
                gradient="linear-gradient(135deg, #10b981, #06b6d4)"
                icon={
                  <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" className="w-6 h-6">
                    <path d="M9 12l2 2 4-4" />
                    <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
                  </svg>
                }
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="glass-card p-6">
                <p className="text-sm font-medium mb-1" style={{ color: "var(--text-secondary)" }}>
                  Active Borrowers
                </p>
                <p className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
                  <AnimatedCounter value={stats.activeBorrowers} />
                </p>
              </div>

              <div className="glass-card p-6">
                <p className="text-sm font-medium mb-1" style={{ color: "var(--text-secondary)" }}>
                  Loans Disbursed
                </p>
                <p className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
                  <AnimatedCounter value={stats.loansDisbursed} />
                </p>
              </div>

              <div className="glass-card p-6">
                <p className="text-sm font-medium mb-1" style={{ color: "var(--text-secondary)" }}>
                  Last Updated
                </p>
                <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                  {new Date(stats.lastUpdated).toLocaleString()}
                </p>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
