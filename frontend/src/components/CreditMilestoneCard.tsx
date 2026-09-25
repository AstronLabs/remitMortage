"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { ArrowUp, CheckCircle2, Clock } from "lucide-react";
import { CreditTier, PaymentMilestone, TIER_CONFIG } from "@/lib/creditRecovery";

interface CreditMilestoneCardProps {
  milestone: PaymentMilestone;
  isNext: boolean;
  allCompletedUpTo: number;
  isFuture: boolean;
}

export function CreditMilestoneCard({
  milestone,
  isNext,
  allCompletedUpTo,
  isFuture,
}: CreditMilestoneCardProps) {
  const isCompleted = milestone.month <= allCompletedUpTo;
  const tierColor = TIER_CONFIG[milestone.projectedTier].color;

  return (
    <div
      data-testid="credit-milestone"
      data-month={milestone.month}
      data-status={isCompleted ? "completed" : isNext ? "current" : "future"}
      className={`rounded-lg border p-3 transition-all ${
        isCompleted
          ? "border-emerald-500/20 bg-emerald-500/5"
          : isNext
            ? "border-cyan-500/30 bg-cyan-500/10 ring-1 ring-cyan-500/20"
            : "border-zinc-800 bg-zinc-900/50"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2.5 min-w-0">
          {isCompleted ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-emerald-400" />
          ) : isNext ? (
            <span className="relative flex h-4 w-4 shrink-0 mt-0.5 items-center justify-center">
              <span className="absolute h-full w-full animate-ping rounded-full bg-cyan-400/40" />
              <Clock className="relative h-4 w-4 text-cyan-400" />
            </span>
          ) : (
            <div className="h-4 w-4 shrink-0 mt-0.5 rounded-full border-2 border-zinc-700" />
          )}

          <div>
            <p
              className={`text-sm font-semibold ${
                isCompleted ? "text-emerald-300" : "text-zinc-100"
              }`}
            >
              {milestone.label}
            </p>
            {isCompleted && (
              <p className="text-xs text-emerald-400/80 mt-0.5">Payment completed</p>
            )}
            {isNext && (
              <p className="text-xs text-cyan-400/80 mt-0.5">Next milestone — on-time payment required</p>
            )}
            {isFuture && (
              <p className="text-xs text-zinc-500 mt-0.5">{milestone.projectedTier} tier projected</p>
            )}
          </div>
        </div>

        <div className="text-right shrink-0">
          <div className="flex items-center gap-1 justify-end">
            {milestone.scoreImprovement > 0 && !isFuture && (
              <ArrowUp className="h-3 w-3 text-emerald-400" />
            )}
            <span
              className={`text-sm font-bold ${
                isCompleted
                  ? "text-emerald-400"
                  : isNext
                    ? "text-cyan-400"
                    : "text-zinc-400"
              }`}
            >
              +{milestone.scoreImprovement}
            </span>
          </div>
          <p className="text-xs font-mono" style={{ color: tierColor }}>
            {milestone.projectedScore} pts · {milestone.projectedTier}
          </p>
          <p className="text-[10px] text-zinc-500">{milestone.projectedRate}% APR</p>
        </div>
      </div>
    </div>
  );
}
