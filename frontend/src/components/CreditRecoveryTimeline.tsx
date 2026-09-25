"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Area,
  AreaChart,
  Legend,
} from "recharts";
import { TrendingUp } from "lucide-react";
import { CreditScoreGauge } from "./CreditScoreGauge";
import { CreditMilestoneCard } from "./CreditMilestoneCard";
import {
  CreditRecoveryPlan,
  CreditScoreSnapshot,
  PaymentMilestone,
  getTier,
  TIER_CONFIG,
} from "@/lib/creditRecovery";

interface CreditRecoveryTimelineProps {
  plan: CreditRecoveryPlan;
}

interface ChartDataPoint {
  label: string;
  score: number;
  tier: string;
  isProjected: boolean;
}

export function CreditRecoveryTimeline({ plan }: CreditRecoveryTimelineProps) {
  const allCompletedUpTo = Math.max(0, plan.onTimePayments - plan.missedPayments);

  const chartData: ChartDataPoint[] = [
    ...plan.history.map((h) => ({
      label: h.label,
      score: h.score,
      tier: h.tier,
      isProjected: false,
    })),
    {
      label: "Now",
      score: plan.currentScore,
      tier: plan.currentTier,
      isProjected: false,
    },
    ...plan.milestones
      .filter((m) => m.month % 2 === 0 || m.month === plan.milestones.length)
      .map((m) => ({
        label: `M${m.month}`,
        score: m.projectedScore,
        tier: m.projectedTier,
        isProjected: true,
      })),
  ];

  return (
    <div
      data-testid="credit-recovery-timeline"
      className="space-y-6"
    >
      {/* Gauge */}
      <CreditScoreGauge
        currentScore={plan.currentScore}
        currentTier={plan.currentTier}
        targetScore={plan.targetScore}
        targetTier={plan.targetTier}
      />

      {/* Chart */}
      <div className="p-4 bg-zinc-900/60 border border-zinc-800 rounded-xl">
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
            <defs>
              <linearGradient id="pastGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#ef4444" stopOpacity={0.15} />
                <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="projGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.15} />
                <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
            <XAxis
              dataKey="label"
              stroke="#52525b"
              tick={{ fill: "#a1a1aa", fontSize: 10 }}
            />
            <YAxis
              domain={[0, 100]}
              stroke="#52525b"
              tick={{ fill: "#a1a1aa", fontSize: 10 }}
            />
            <Tooltip
              contentStyle={{
                background: "#18181b",
                border: "1px solid #27272a",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              formatter={(value: number, _name: string, props: any) => {
                return [`${value} pts · ${props.payload.tier}`, props.payload.isProjected ? "Projected" : "Actual"];
              }}
            />

            <ReferenceLine
              y={80}
              stroke={TIER_CONFIG.Excellent.color}
              strokeDasharray="3 3"
              strokeOpacity={0.5}
              label={{ value: "Excellent", fill: TIER_CONFIG.Excellent.color, fontSize: 9 }}
            />
            <ReferenceLine
              y={60}
              stroke={TIER_CONFIG.Good.color}
              strokeDasharray="3 3"
              strokeOpacity={0.5}
              label={{ value: "Good", fill: TIER_CONFIG.Good.color, fontSize: 9 }}
            />
            <ReferenceLine
              y={40}
              stroke={TIER_CONFIG.Fair.color}
              strokeDasharray="3 3"
              strokeOpacity={0.5}
              label={{ value: "Fair", fill: TIER_CONFIG.Fair.color, fontSize: 9 }}
            />

            <Line
              type="monotone"
              dataKey="score"
              stroke="#06b6d4"
              strokeWidth={2}
              dot={false}
            />
            <Area
              type="monotone"
              dataKey="score"
              stroke="none"
              fill="url(#projGradient)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Milestone list */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Payment milestones
          </p>
          <div className="flex items-center gap-3 text-[10px] text-zinc-500">
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              Completed
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-cyan-400" />
              Current
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-zinc-600" />
              Future
            </span>
          </div>
        </div>

        <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
          {plan.milestones.map((milestone, idx) => {
            const isNext =
              milestone.month ===
              plan.milestones.find(
                (m) => m.month > allCompletedUpTo
              )?.month;

            return (
              <CreditMilestoneCard
                key={milestone.month}
                milestone={milestone}
                isNext={isNext}
                allCompletedUpTo={allCompletedUpTo}
                isFuture={milestone.month > allCompletedUpTo + 1}
              />
            );
          })}
        </div>
      </div>

      {/* Tier rate summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {(Object.entries(TIER_CONFIG) as [string, typeof TIER_CONFIG[keyof typeof TIER_CONFIG]][]).map(
          ([tier, cfg]) => {
            const isCurrentTier = tier === plan.currentTier;
            const isTargetTier = tier === plan.targetTier;

            return (
              <div
                key={tier}
                className={`rounded-lg border p-2.5 text-center transition-all ${
                  isCurrentTier
                    ? "border-cyan-500/30 bg-cyan-500/10"
                    : isTargetTier
                      ? "border-emerald-500/20 bg-emerald-500/5"
                      : "border-zinc-800 bg-zinc-900/50"
                }`}
              >
                <div className="flex items-center justify-center gap-1 mb-1">
                  <div
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: cfg.color }}
                  />
                  <span
                    className={`text-[10px] font-bold uppercase tracking-wider ${
                      isCurrentTier || isTargetTier ? "text-zinc-200" : "text-zinc-500"
                    }`}
                  >
                    {tier}
                  </span>
                  {isCurrentTier && (
                    <span className="text-[8px] font-bold text-cyan-400 bg-cyan-500/15 px-1 py-0.5 rounded">
                      NOW
                    </span>
                  )}
                  {isTargetTier && !isCurrentTier && (
                    <span className="text-[8px] font-bold text-emerald-400 bg-emerald-500/15 px-1 py-0.5 rounded">
                      TARGET
                    </span>
                  )}
                </div>
                <p className="text-xs font-bold text-zinc-300">{cfg.rate}% APR</p>
                <p className="text-[9px] text-zinc-500 mt-0.5">{cfg.min}+ pts</p>
              </div>
            );
          }
        )}
      </div>
    </div>
  );
}
