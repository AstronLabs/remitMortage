// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

export type TrancheType = "Senior" | "Junior";

export interface TrancheHolding {
  tranche: TrancheType;
  amount: number;
  riskTier?: "Low" | "Medium" | "High";
  apyBps?: number;
}

export interface ConcentrationMetric {
  tranche: TrancheType;
  amount: number;
  share: number; // 0 to 1
  percentage: number; // 0 to 100
  isExceeded: boolean;
}

export interface RebalancingOption {
  targetTranche: TrancheType;
  recommendedAmount: number;
  rationale: string;
  expectedApyBps?: number;
}

export interface RebalancingSuggestion {
  id: string; // Occurrence-specific identifier
  dominantTranche: TrancheType;
  concentrationShare: number;
  concentrationPercentage: number;
  threshold: number;
  message: string;
  options: RebalancingOption[];
  timestamp: number;
}

export interface ConcentrationAnalysisResult {
  totalPortfolioValue: number;
  threshold: number;
  metrics: ConcentrationMetric[];
  highestConcentration: ConcentrationMetric | null;
  isOverConcentrated: boolean;
  suggestion: RebalancingSuggestion | null;
}

export const DEFAULT_CONCENTRATION_THRESHOLD = 0.7; // 70%
const DISMISSED_OCCURRENCES_KEY = "investor_dismissed_rebalancing_events";

/**
 * Computes portfolio concentration metrics across tranches and surfaces
 * actionable rebalancing recommendations if a single tranche exceeds the threshold.
 */
export function computeConcentrationMetrics(
  holdings: TrancheHolding[],
  threshold: number = DEFAULT_CONCENTRATION_THRESHOLD,
  rates?: { seniorApyBps?: number; juniorApyBps?: number }
): ConcentrationAnalysisResult {
  const validHoldings = holdings.filter((h) => h.amount > 0);
  const totalValue = validHoldings.reduce((sum, h) => sum + h.amount, 0);

  if (totalValue <= 0 || validHoldings.length === 0) {
    return {
      totalPortfolioValue: 0,
      threshold,
      metrics: [],
      highestConcentration: null,
      isOverConcentrated: false,
      suggestion: null,
    };
  }

  // Aggregate amounts by tranche
  const trancheTotals: Record<TrancheType, number> = {
    Senior: 0,
    Junior: 0,
  };

  validHoldings.forEach((h) => {
    if (trancheTotals[h.tranche] !== undefined) {
      trancheTotals[h.tranche] += h.amount;
    }
  });

  const metrics: ConcentrationMetric[] = (["Senior", "Junior"] as TrancheType[]).map((tranche) => {
    const amount = trancheTotals[tranche];
    const share = amount / totalValue;
    return {
      tranche,
      amount,
      share,
      percentage: Math.round(share * 1000) / 10,
      isExceeded: share > threshold,
    };
  });

  metrics.sort((a, b) => b.share - a.share);
  const highest = metrics[0] || null;
  const isOverConcentrated = highest ? highest.share > threshold : false;

  let suggestion: RebalancingSuggestion | null = null;

  if (isOverConcentrated && highest) {
    const targetTranche: TrancheType = highest.tranche === "Senior" ? "Junior" : "Senior";
    
    // Amount required to diversify to bring concentration down to threshold
    const excessAmount = highest.amount - totalValue * threshold;
    const recommendedAmount = Math.max(0, Math.round(excessAmount * 100) / 100);

    const seniorApy = rates?.seniorApyBps ?? 400;
    const juniorApy = rates?.juniorApyBps ?? 620;
    const targetApy = targetTranche === "Senior" ? seniorApy : juniorApy;

    const rationale =
      highest.tranche === "Senior"
        ? `Over ${(highest.percentage).toFixed(1)}% of your portfolio is in Senior Tranche. Allocating to Junior Tranche (~${(juniorApy / 100).toFixed(1)}% APY) provides higher blended yield while mitigating single-tranche concentration.`
        : `Over ${(highest.percentage).toFixed(1)}% of your portfolio is in Junior Tranche. Allocating to Senior Tranche (~${(seniorApy / 100).toFixed(1)}% APY) offers protected capital preservation and risk diversification.`;

    // Unique signature for this specific concentration event
    const occurrenceId = `reb_${highest.tranche}_amt${Math.round(highest.amount)}_tot${Math.round(totalValue)}_th${Math.round(threshold * 100)}`;

    suggestion = {
      id: occurrenceId,
      dominantTranche: highest.tranche,
      concentrationShare: highest.share,
      concentrationPercentage: highest.percentage,
      threshold,
      message: `High concentration detected: ${highest.percentage.toFixed(1)}% in ${highest.tranche} Tranche.`,
      options: [
        {
          targetTranche,
          recommendedAmount: recommendedAmount > 0 ? recommendedAmount : Math.round((totalValue * 0.2) * 100) / 100,
          rationale,
          expectedApyBps: targetApy,
        },
      ],
      timestamp: Date.now(),
    };
  }

  return {
    totalPortfolioValue: totalValue,
    threshold,
    metrics,
    highestConcentration: highest,
    isOverConcentrated,
    suggestion,
  };
}

/**
 * Check if a specific occurrence of a rebalancing suggestion has been dismissed.
 */
export function isOccurrenceDismissed(
  occurrenceId: string,
  storage?: Storage
): boolean {
  if (typeof window === "undefined" && !storage) return false;
  try {
    const s = storage || window.localStorage;
    const raw = s.getItem(DISMISSED_OCCURRENCES_KEY);
    if (!raw) return false;
    const dismissedList: string[] = JSON.parse(raw);
    return Array.isArray(dismissedList) && dismissedList.includes(occurrenceId);
  } catch {
    return false;
  }
}

/**
 * Dismiss a specific occurrence without permanently suppressing future concentration events.
 */
export function dismissOccurrence(
  occurrenceId: string,
  storage?: Storage
): void {
  if (typeof window === "undefined" && !storage) return;
  try {
    const s = storage || window.localStorage;
    const raw = s.getItem(DISMISSED_OCCURRENCES_KEY);
    const dismissedList: string[] = raw ? JSON.parse(raw) : [];
    if (!dismissedList.includes(occurrenceId)) {
      dismissedList.push(occurrenceId);
      // Keep list bounded to last 50 dismissed occurrences
      if (dismissedList.length > 50) dismissedList.shift();
      s.setItem(DISMISSED_OCCURRENCES_KEY, JSON.stringify(dismissedList));
    }
  } catch {
    // Fail silently if storage is not available
  }
}
