// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Score explanation with counterfactual hints (issue #978).
 *
 * Rebuilds the scoring inputs from a stored verification result, breaks the
 * score into per-factor contributions, and for the three factors holding the
 * score back the most finds the smallest change to that factor alone that
 * would lift the score into the next band.
 */

import { activeModelWeights, scoreActiveModel, type ScoreReason } from "./scoring.js";
import type { RemittanceAnalysis } from "./stellar.js";

type Factor = ScoreReason["factor"];

/** Lower bound of each band above "Insufficient", lowest first. */
export const SCORE_BANDS: ReadonlyArray<{ tier: string; minScore: number }> = [
  { tier: "Fair", minScore: 40 },
  { tier: "Good", minScore: 60 },
  { tier: "Excellent", minScore: 80 },
];

const FREQUENCY_THRESHOLDS_DAYS = [90, 60, 35];
const DURATION_THRESHOLDS_MONTHS = [3, 6, 12];
const VOLUME_THRESHOLDS_USDC = [500, 2000, 5000];
const MAX_HINTS = 3;

/** The stored fields of a `VerificationResult` the explanation needs. */
export interface StoredScoreInputs {
  totalPayments: number;
  totalVolume: number;
  spanMonths: number;
  scoreBreakdown?: unknown;
}

export interface ScoreFactorContribution {
  factor: Factor;
  code: string;
  text: string;
  contribution: number;
  maxContribution: number;
}

export interface CounterfactualHint {
  factor: Factor;
  unit: "coefficient_of_variation" | "payments" | "months" | "usdc";
  current: number;
  target: number;
  change: string;
  projectedScore: number;
  /** False when even the largest change to this factor alone falls short. */
  reachesNextBand: boolean;
}

export interface ScoreExplanation {
  score: number;
  tier: string;
  factors: ScoreFactorContribution[];
  nextBand: { tier: string; minScore: number } | null;
  hints: CounterfactualHint[];
}

interface Candidate {
  analysis: RemittanceAnalysis;
  current: number;
  target: number;
  change: string;
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function storedConsistencyPoints(breakdown: unknown): number | null {
  if (breakdown && typeof breakdown === "object") {
    const value = (breakdown as Record<string, unknown>).consistency;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function buildAnalysis(payments: number, volume: number, spanMonths: number, cv: number): RemittanceAnalysis {
  const average = payments > 0 ? volume / payments : 0;
  return {
    senderAddress: "",
    recipientAddress: "",
    selfDealing: false,
    eligible: true,
    reason: "",
    totalPayments: payments,
    totalAmountUSDC: String(volume),
    averageAmountUSDC: String(average),
    standardDeviation: cv * average,
    firstPayment: null,
    lastPayment: null,
    spanMonths,
  };
}

/**
 * Rebuilds a `RemittanceAnalysis` from stored inputs. Only the coefficient of
 * variation is not stored, so it is backed out of the stored consistency
 * points, which reproduces the same consistency score.
 */
export function analysisFromStoredInputs(inputs: StoredScoreInputs): { analysis: RemittanceAnalysis; cv: number } {
  const weight = activeModelWeights().consistency;
  const points = storedConsistencyPoints(inputs.scoreBreakdown) ?? 0;
  const cv = Math.max(0, 1 - points / weight);
  return {
    analysis: buildAnalysis(inputs.totalPayments, inputs.totalVolume, inputs.spanMonths, cv),
    cv,
  };
}

function candidatesFor(factor: Factor, inputs: StoredScoreInputs, cv: number, currentPoints: number): Candidate[] {
  const { totalPayments: payments, totalVolume: volume, spanMonths: span } = inputs;
  const out: Candidate[] = [];

  switch (factor) {
    case "consistency": {
      const weight = activeModelWeights().consistency;
      for (let points = currentPoints + 1; points <= weight; points++) {
        // Largest CV (3 dp) that still rounds up to `points`.
        const target = Math.max(0, Math.floor((1 - (points - 0.5) / weight) * 1000) / 1000);
        if (target >= cv) continue;
        out.push({
          analysis: buildAnalysis(payments, volume, span, target),
          current: round(cv, 3),
          target,
          change: `Keep payment amounts steadier, so they vary by no more than ${Math.round(target * 100)}% from the average.`,
        });
      }
      break;
    }
    case "frequency": {
      for (const days of FREQUENCY_THRESHOLDS_DAYS) {
        const target = Math.ceil((span * 30) / days) + 1;
        if (target <= payments) continue;
        out.push({
          analysis: buildAnalysis(target, volume, span, cv),
          current: payments,
          target,
          change: `Make ${target - payments} more payment(s) within the same ${round(span, 1)} month period, about one every ${days} days or less.`,
        });
      }
      break;
    }
    case "duration": {
      const gapDays = payments > 1 ? (span * 30) / (payments - 1) : 30;
      for (const months of DURATION_THRESHOLDS_MONTHS) {
        if (months <= span) continue;
        // Keep the current cadence so only the history length changes.
        const scaledPayments = Math.max(payments, Math.ceil((months * 30) / gapDays) + 1);
        out.push({
          analysis: buildAnalysis(scaledPayments, volume, months, cv),
          current: round(span, 1),
          target: months,
          change: `Keep paying on your current schedule until your history spans ${months} months.`,
        });
      }
      break;
    }
    case "volume": {
      for (const usdc of VOLUME_THRESHOLDS_USDC) {
        if (usdc <= volume) continue;
        out.push({
          analysis: buildAnalysis(payments, usdc, span, cv),
          current: round(volume, 2),
          target: usdc,
          change: `Send $${round(usdc - volume, 2)} more in total, reaching $${usdc}.`,
        });
      }
      break;
    }
  }
  return out;
}

const UNITS: Record<Factor, CounterfactualHint["unit"]> = {
  consistency: "coefficient_of_variation",
  frequency: "payments",
  duration: "months",
  volume: "usdc",
};

/** Explains a stored score and suggests the smallest per-factor improvements. */
export function explainScore(inputs: StoredScoreInputs): ScoreExplanation {
  const { analysis, cv } = analysisFromStoredInputs(inputs);
  const base = scoreActiveModel(analysis);

  const factors: ScoreFactorContribution[] = base.reasons.map((r) => ({
    factor: r.factor,
    code: r.code,
    text: r.text,
    contribution: r.contribution,
    maxContribution: r.maxContribution,
  }));

  const nextBand = SCORE_BANDS.find((band) => band.minScore > base.score) ?? null;
  const insufficientHistory = inputs.totalPayments <= 1 || inputs.totalVolume <= 0;
  if (!nextBand || insufficientHistory) {
    return { score: base.score, tier: base.tier, factors, nextBand, hints: [] };
  }

  // `reasons` is already ordered by deficit, largest first.
  const negative = base.reasons.filter((r) => r.maxContribution > r.contribution).slice(0, MAX_HINTS);
  const hints: CounterfactualHint[] = [];
  for (const reason of negative) {
    const candidates = candidatesFor(reason.factor, inputs, cv, reason.contribution);
    if (candidates.length === 0) continue;

    let chosen: Candidate | null = null;
    let projected = base.score;
    for (const candidate of candidates) {
      projected = scoreActiveModel(candidate.analysis).score;
      if (projected >= nextBand.minScore) {
        chosen = candidate;
        break;
      }
    }
    const pick = chosen ?? candidates[candidates.length - 1];
    hints.push({
      factor: reason.factor,
      unit: UNITS[reason.factor],
      current: pick.current,
      target: pick.target,
      change: pick.change,
      projectedScore: chosen ? projected : scoreActiveModel(pick.analysis).score,
      reachesNextBand: chosen !== null,
    });
  }

  return { score: base.score, tier: base.tier, factors, nextBand, hints };
}
