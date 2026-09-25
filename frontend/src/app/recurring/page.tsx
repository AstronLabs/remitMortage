"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

export const dynamic = "force-dynamic";

import React, { useEffect, useState, useMemo, useCallback } from "react";
import loadDynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Calendar, Clock, DollarSign, ArrowRight } from "lucide-react";
import { OptionalWalletProvider, useWallet } from "../../context/WalletContext";
import RecurringPaymentCard, {
  type RecurringSchedule,
} from "../../components/RecurringPaymentCard";
import { formatInterval, formatCountdown } from "@/lib/soroban";

const Navbar = loadDynamic(() => import("../../components/Navbar"), { ssr: false });

type DisbursementEntry = {
  date: Date;
  dateLabel: string;
  amount: string;
  scheduleName: string;
  scheduleId: string;
};

function formatUSDC(raw: string | number): string {
  const n = typeof raw === "string" ? parseFloat(raw) : raw;
  if (isNaN(n)) return "0.00";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(iso: Date): string {
  return iso.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function generateUpcomingDisbursements(
  schedules: RecurringSchedule[],
  horizonDays: number = 30,
): DisbursementEntry[] {
  const now = Date.now();
  const horizon = now + horizonDays * 24 * 60 * 60 * 1000;
  const entries: DisbursementEntry[] = [];

  for (const schedule of schedules) {
    if (schedule.status !== "active") continue;

    let nextAt = schedule.nextDisbursementAt * 1000;
    const intervalMs = schedule.intervalSecs * 1000;

    while (nextAt <= horizon) {
      if (nextAt >= now) {
        entries.push({
          date: new Date(nextAt),
          dateLabel: formatDate(new Date(nextAt)),
          amount: schedule.amountPerPeriod,
          scheduleName: schedule.name,
          scheduleId: schedule.id,
        });
      }
      nextAt += intervalMs;
    }
  }

  entries.sort((a, b) => a.date.getTime() - b.date.getTime());
  return entries;
}

function TimelineView({ entries }: { entries: DisbursementEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="p-6 bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)] text-center">
        <Calendar className="w-8 h-8 text-slate-500 mx-auto mb-3" />
        <p className="text-sm text-slate-400">No upcoming disbursements in the next 30 days.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {entries.map((entry, i) => (
        <div
          key={`${entry.scheduleId}-${entry.date.getTime()}`}
          className="flex items-center gap-4 p-4 bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)] hover:border-cyan-500/20 transition-colors"
        >
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
            <Calendar className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-white font-medium truncate">{entry.scheduleName}</p>
            <p className="text-xs text-slate-400">{entry.dateLabel}</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-sm font-mono text-white font-semibold">
              {formatUSDC(entry.amount)} USDC
            </span>
            <ArrowRight className="w-4 h-4 text-slate-500" />
          </div>
        </div>
      ))}
    </div>
  );
}

function RecurringInner() {
  const router = useRouter();
  const { isConnected, publicKey } = useWallet();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<RecurringSchedule[]>([]);

  useEffect(() => {
    if (!isConnected) {
      router.push("/");
      return;
    }
    if (!publicKey) return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        // TODO: Fetch real schedules from Soroban contract
        // For now, use mock data to demonstrate the UI
        const mockSchedules: RecurringSchedule[] = [
          {
            id: "sched-001",
            name: "Monthly Contractor Payment",
            type: "fixed",
            recipient: "GBWKY3LZ7Q7WQVJH4K3Q5Z6X7Y8Z9A0B1C2D3E4F5G6H7I8J9K0L",
            amountPerPeriod: "5000.00",
            intervalSecs: 30 * 24 * 60 * 60,
            lastDisbursedAt: Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60,
            nextDisbursementAt: Math.floor(Date.now() / 1000),
            totalDisbursed: "15000.00",
            status: "active",
          },
          {
            id: "sched-002",
            name: "Vesting Schedule - Team Tokens",
            type: "linear_vesting",
            recipient: "GABC1234567890DEF1234567890ABCDEF1234567890ABCDEF123456",
            amountPerPeriod: "10000.00",
            intervalSecs: 7 * 24 * 60 * 60,
            lastDisbursedAt: Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60,
            nextDisbursementAt: Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60,
            totalDisbursed: "30000.00",
            status: "active",
            totalCap: "100000.00",
            claimed: "30000.00",
            claimable: "10000.00",
          },
          {
            id: "sched-003",
            name: "Weekly Operations Fund",
            type: "fixed",
            recipient: "GDEF9876543210CBA9876543210DEFABCDEF9876543210CBA987654",
            amountPerPeriod: "2000.00",
            intervalSecs: 7 * 24 * 60 * 60,
            lastDisbursedAt: Math.floor(Date.now() / 1000) - 5 * 24 * 60 * 60,
            nextDisbursementAt: Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60,
            totalDisbursed: "8000.00",
            status: "active",
          },
        ];

        if (!cancelled) {
          setSchedules(mockSchedules);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Failed to load schedules");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [isConnected, publicKey, router]);

  const upcomingDisbursements = useMemo(
    () => generateUpcomingDisbursements(schedules),
    [schedules],
  );

  const handleDisburse = useCallback(async (scheduleId: string) => {
    // TODO: Call disburseRecurring from Soroban contract
    await new Promise((r) => setTimeout(r, 1500));
    setSchedules((prev) =>
      prev.map((s) =>
        s.id === scheduleId
          ? { ...s, lastDisbursedAt: Math.floor(Date.now() / 1000), nextDisbursementAt: Math.floor(Date.now() / 1000) + s.intervalSecs }
          : s,
      ),
    );
  }, []);

  const activeSchedules = schedules.filter((s) => s.status === "active");
  const totalUpcomingAmount = upcomingDisbursements.reduce(
    (sum, e) => sum + parseFloat(e.amount),
    0,
  );

  return (
    <div className="rm-app-page min-h-screen bg-[#060913] text-slate-100 pb-20">
      <Navbar />

      <main className="max-w-6xl mx-auto px-6 pt-32 pb-20">
        <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-cyan-500/10 text-cyan-400 text-xs font-semibold uppercase tracking-wider mb-4 border border-cyan-500/20">
          Recurring Payments
        </span>
        <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight text-white mb-2">
          Payment <span className="gradient-text">Schedules</span>
        </h1>
        <p className="text-slate-400 text-sm md:text-base mb-8">
          Manage recurring disbursements and visualize upcoming payment timelines.
        </p>

        {loading && (
          <div className="p-6 bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)] text-sm text-[var(--text-muted)]">
            Loading schedules{"\u2026"}
          </div>
        )}

        {error && (
          <div role="alert" className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400 mb-6">
            {error}
          </div>
        )}

        {!loading && !error && (
          <div className="space-y-8">
            {/* Summary Stats */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="p-5 bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)]">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
                    <DollarSign className="w-5 h-5 text-cyan-400" />
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Active Schedules</p>
                    <p className="text-xl font-bold text-white">{activeSchedules.length}</p>
                  </div>
                </div>
              </div>
              <div className="p-5 bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)]">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                    <Calendar className="w-5 h-5 text-emerald-400" />
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Upcoming (30d)</p>
                    <p className="text-xl font-bold text-white">{upcomingDisbursements.length}</p>
                  </div>
                </div>
              </div>
              <div className="p-5 bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)]">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                    <Clock className="w-5 h-5 text-amber-400" />
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Total Upcoming</p>
                    <p className="text-xl font-bold text-white font-mono">{formatUSDC(totalUpcomingAmount)} USDC</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Timeline View */}
            <section aria-labelledby="timeline-heading">
              <h2 id="timeline-heading" className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <Calendar className="w-5 h-5 text-cyan-400" />
                Upcoming Disbursements
              </h2>
              <TimelineView entries={upcomingDisbursements} />
            </section>

            {/* Schedule Cards */}
            <section aria-labelledby="schedules-heading">
              <h2 id="schedules-heading" className="text-lg font-semibold text-white mb-4">
                Active Schedules
              </h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {schedules.map((schedule) => (
                  <RecurringPaymentCard
                    key={schedule.id}
                    schedule={schedule}
                    onDisburse={handleDisburse}
                  />
                ))}
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

export default function RecurringPage() {
  return (
    <OptionalWalletProvider>
      <RecurringInner />
    </OptionalWalletProvider>
  );
}
