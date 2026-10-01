// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState, useEffect } from "react";
import {
  type ConcentrationAnalysisResult,
  type TrancheType,
  isOccurrenceDismissed,
  dismissOccurrence,
} from "../../lib/investorRebalancing";

interface InvestorRebalancingSuggestionsProps {
  analysis: ConcentrationAnalysisResult;
  onSelectTranche?: (tranche: TrancheType, amount?: number) => void;
  onDismiss?: (occurrenceId: string) => void;
}

export default function InvestorRebalancingSuggestions({
  analysis,
  onSelectTranche,
  onDismiss,
}: InvestorRebalancingSuggestionsProps) {
  const { suggestion, highestConcentration, metrics, totalPortfolioValue } = analysis;
  const [isDismissed, setIsDismissed] = useState(false);

  useEffect(() => {
    if (suggestion) {
      setIsDismissed(isOccurrenceDismissed(suggestion.id));
    } else {
      setIsDismissed(false);
    }
  }, [suggestion?.id]);

  if (!analysis.isOverConcentrated || !suggestion || isDismissed || totalPortfolioValue <= 0) {
    return null;
  }

  const handleDismiss = () => {
    dismissOccurrence(suggestion.id);
    setIsDismissed(true);
    if (onDismiss) {
      onDismiss(suggestion.id);
    }
  };

  const option = suggestion.options[0];

  return (
    <div
      role="region"
      aria-label="Portfolio auto-diversification recommendation"
      className="p-5 mb-8 rounded-2xl bg-amber-500/10 border border-amber-500/30 backdrop-blur-xl transition-all duration-300 relative overflow-hidden"
    >
      <div className="absolute top-0 left-0 h-1 bg-gradient-to-r from-amber-400 via-orange-500 to-indigo-500 w-full" />
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="space-y-2 flex-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center justify-center p-1 rounded-lg bg-amber-500/20 text-amber-400 text-sm">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </span>
            <span className="text-xs font-bold uppercase tracking-wider text-amber-400">
              Auto-Diversification Suggestion
            </span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
              {suggestion.concentrationPercentage.toFixed(0)}% Concentrated
            </span>
          </div>

          <p className="text-sm font-semibold text-white">
            {suggestion.message}
          </p>

          {option && (
            <p className="text-xs text-slate-300 leading-relaxed max-w-3xl">
              {option.rationale}
            </p>
          )}

          {/* Allocation Breakdown Progress Bar */}
          <div className="pt-1">
            <div className="flex justify-between text-[11px] text-slate-400 mb-1 font-mono">
              {metrics.map((m) => (
                <span key={m.tranche}>
                  {m.tranche}: {m.percentage.toFixed(1)}% (${m.amount.toLocaleString()})
                </span>
              ))}
            </div>
            <div className="flex h-2 rounded-full overflow-hidden bg-slate-950/80 border border-slate-800">
              {metrics.map((m) => (
                <div
                  key={m.tranche}
                  style={{ width: `${m.percentage}%` }}
                  className={m.tranche === "Senior" ? "bg-indigo-500" : "bg-cyan-400"}
                  title={`${m.tranche}: ${m.percentage}%`}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-3 shrink-0 self-end md:self-center">
          {option && onSelectTranche && (
            <button
              type="button"
              onClick={() => onSelectTranche(option.targetTranche, option.recommendedAmount)}
              className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-slate-950 font-bold text-xs shadow-lg shadow-amber-500/20 transition-all flex items-center gap-1.5"
            >
              <span>Diversify into {option.targetTranche}</span>
              <span className="text-[10px] bg-slate-950/20 px-1.5 py-0.5 rounded font-mono">
                ~${option.recommendedAmount.toLocaleString()}
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dismiss rebalancing suggestion"
            className="px-3 py-2 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 text-slate-400 hover:text-white text-xs font-semibold border border-slate-700/50 transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
