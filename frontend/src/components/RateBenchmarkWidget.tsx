"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { useRateBenchmark } from "../hooks/useRateBenchmark";

function bpsToPercent(bps: number): string {
  return (bps / 100).toFixed(2);
}

function RateBar({
  label,
  rateBps,
  maxBps,
  color,
}: {
  label: string;
  rateBps: number;
  maxBps: number;
  color: string;
}) {
  const pct = maxBps > 0 ? Math.min((rateBps / maxBps) * 100, 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-[var(--text-secondary)] w-24 shrink-0 font-medium">
        {label}
      </span>
      <div className="flex-1 h-3 bg-[var(--bg-secondary)] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700 ease-out"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-sm font-bold text-[var(--text-primary)] w-16 text-right">
        {bpsToPercent(rateBps)}%
      </span>
    </div>
  );
}

interface RateBenchmarkWidgetProps {
  userRateBps?: number;
  riskTier?: string;
}

export default function RateBenchmarkWidget({
  userRateBps,
  riskTier,
}: RateBenchmarkWidgetProps) {
  const { data, loading, error } = useRateBenchmark(riskTier);

  if (loading) {
    return (
      <div className="glass-card p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-5 w-48 bg-[var(--bg-secondary)] rounded" />
          <div className="h-3 w-full bg-[var(--bg-secondary)] rounded" />
          <div className="h-3 w-3/4 bg-[var(--bg-secondary)] rounded" />
          <div className="h-3 w-1/2 bg-[var(--bg-secondary)] rounded" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="glass-card p-6">
        <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2">
          Rate Benchmark
        </h3>
        <div className="p-4 bg-amber-950/30 border border-amber-500/30 rounded-lg">
          <p className="text-sm text-amber-200">
            Unable to load benchmark data. Please try again later.
          </p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  if (!data.hasSufficientData) {
    return (
      <div className="glass-card p-6">
        <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2">
          Rate Benchmark
        </h3>
        <div className="p-6 bg-[var(--bg-secondary)]/50 border border-[var(--border-color)] rounded-lg text-center">
          <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-[var(--bg-secondary)] flex items-center justify-center">
            <svg
              className="w-6 h-6 text-[var(--text-muted)]"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <p className="text-sm text-[var(--text-secondary)] font-medium mb-1">
            Not Enough Data
          </p>
          <p className="text-xs text-[var(--text-muted)]">
            We need at least 5 active loans to generate a meaningful rate
            comparison. Check back once more activity has occurred on the
            protocol.
          </p>
        </div>
      </div>
    );
  }

  const maxRate = Math.max(
    data.protocolAvgRateBps,
    data.protocolMedianRateBps,
    data.seniorApyBps,
    data.juniorApyBps,
    userRateBps ?? 0,
    1
  );

  const diff = userRateBps != null ? userRateBps - data.protocolAvgRateBps : null;
  const diffLabel =
    diff === null
      ? ""
      : diff > 0
        ? `+${bpsToPercent(diff)}%`
        : `${bpsToPercent(diff)}%`;
  const diffColor =
    diff === null
      ? ""
      : diff > 0
        ? "text-emerald-400"
        : diff < 0
          ? "text-amber-400"
          : "text-[var(--text-secondary)]";
  const diffDescription =
    diff === null
      ? ""
      : diff > 0
        ? "Your rate is above the protocol average"
        : diff < 0
          ? "Your rate is below the protocol average"
          : "Your rate matches the protocol average";

  return (
    <div className="glass-card p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h3 className="text-lg font-bold text-[var(--text-primary)]">
            Rate Benchmark
          </h3>
          <p className="text-xs text-[var(--text-secondary)]">
            {data.riskTier === "all"
              ? "Protocol-wide rate comparison"
              : `${data.riskTier} tranche comparison`}
          </p>
        </div>
        {diff !== null && (
          <div className="text-right">
            <span className={`text-xl font-extrabold ${diffColor}`}>
              {diffLabel}
            </span>
            <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
              {diffDescription}
            </p>
          </div>
        )}
      </div>

      <div className="space-y-3">
        {userRateBps != null && (
          <RateBar
            label="Your Rate"
            rateBps={userRateBps}
            maxBps={maxRate * 1.1}
            color="#6366f1"
          />
        )}
        <RateBar
          label="Protocol Avg"
          rateBps={data.protocolAvgRateBps}
          maxBps={maxRate * 1.1}
          color="#3b82f6"
        />
        <RateBar
          label="Median"
          rateBps={data.protocolMedianRateBps}
          maxBps={maxRate * 1.1}
          color="#06b6d4"
        />
        <RateBar
          label="Senior"
          rateBps={data.seniorApyBps}
          maxBps={maxRate * 1.1}
          color="#10b981"
        />
        <RateBar
          label="Junior"
          rateBps={data.juniorApyBps}
          maxBps={maxRate * 1.1}
          color="#f59e0b"
        />
      </div>

      <div className="mt-5 pt-4 border-t border-[var(--border-color)] flex items-center justify-between text-xs text-[var(--text-muted)]">
        <span>Based on {data.totalLoans} active loans</span>
        <span>
          Updated{" "}
          {new Date(data.lastUpdated).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>
    </div>
  );
}
