// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { RemittanceAnalysis } from "./stellar.js";

/**
 * One contributing factor behind a credit score, as a stable reason code
 * plus plain-language text.
 *
 * `code` is the reproducible, machine-stable identifier — lending rules
 * generally require adverse decisions to cite a *consistent* reason, not
 * regenerated prose that can drift between releases. Once a code ships, its
 * MEANING (which factor, which tier) must never change; a new tier gets a
 * new code instead of repurposing an old one. See `scoring.test.ts`'s
 * "reason codes are stable" test and `REASON_CODE_CATALOG` below for the
 * full, frozen list.
 */
export interface ScoreReason {
  code: string;
  factor: "consistency" | "frequency" | "duration" | "volume";
  text: string;
  /** Points this factor contributed toward the score. */
  contribution: number;
  /** The factor's maximum possible contribution (its weight). */
  maxContribution: number;
}

export interface CreditScoreResult {
  score: number;
  modelVersion: string;
  breakdown: {
    consistency: number;
    frequency: number;
    duration: number;
    volume: number;
  };
  tier: string;
  /**
   * The four scoring factors as reason codes, ordered by how much each one
   * *held the score back* (largest gap between its max weight and its
   * actual contribution first) — the natural order for "why isn't this
   * score higher," which is what an adverse-decision notice needs to show.
   * Always present and always exactly one entry per factor (see
   * `scoring.test.ts`'s "every score carries reasons" test) — never omitted
   * just because a factor scored well.
   */
  reasons: ScoreReason[];
  shadowScore?: {
    modelVersion: string;
    score: number;
    tier: string;
    breakdown: {
      consistency: number;
      frequency: number;
      duration: number;
      volume: number;
    };
  };
}

export interface ScoringModelConfig {
  activeVersion: string;
  shadowVersion?: string;
  shadowModeEnabled: boolean;
}

export interface ShadowEvaluation {
  id: string;
  timestamp: string;
  activeVersion: string;
  activeScore: number;
  shadowVersion: string;
  shadowScore: number;
  delta: number;
}

let currentModelConfig: ScoringModelConfig = {
  activeVersion: "v1.0.0",
  shadowVersion: "v1.1.0-shadow",
  shadowModeEnabled: true,
};

const shadowEvaluationsLog: ShadowEvaluation[] = [];

export function getModelConfig(): ScoringModelConfig {
  return { ...currentModelConfig };
}

export function updateModelConfig(newConfig: Partial<ScoringModelConfig>): ScoringModelConfig {
  currentModelConfig = { ...currentModelConfig, ...newConfig };
  return getModelConfig();
}

export function getShadowEvaluations(): ShadowEvaluation[] {
  return [...shadowEvaluationsLog];
}

export function getShadowMetrics() {
  const count = shadowEvaluationsLog.length;
  if (count === 0) {
    return { sampleCount: 0, avgActiveScore: 0, avgShadowScore: 0, avgDelta: 0 };
  }
  const sumActive = shadowEvaluationsLog.reduce((s, e) => s + e.activeScore, 0);
  const sumShadow = shadowEvaluationsLog.reduce((s, e) => s + e.shadowScore, 0);
  const sumDelta = shadowEvaluationsLog.reduce((s, e) => s + e.delta, 0);
  return {
    sampleCount: count,
    avgActiveScore: Math.round(sumActive / count),
    avgShadowScore: Math.round(sumShadow / count),
    avgDelta: Math.round((sumDelta / count) * 100) / 100,
  };
}

const WEIGHTS_V1 = {
  CONSISTENCY: 40,
  FREQUENCY: 25,
  DURATION: 20,
  VOLUME: 15,
};

// Candidate shadow model (v1.1.0-shadow) with reweighted metrics favoring history & volume
const WEIGHTS_SHADOW = {
  CONSISTENCY: 35,
  FREQUENCY: 20,
  DURATION: 25,
  VOLUME: 20,
};

/**
 * Stable reason-code catalog. Each entry's `code` is a permanent identifier:
 * once shipped, a code's meaning never changes — a new tier or threshold
 * gets a brand-new code rather than redefining an existing one, so a reason
 * code attached to a score years ago still means the same thing today.
 */
const REASON_CODE_CATALOG = {
  consistencyHigh: { code: "CONSISTENCY_HIGH", text: "Payment amounts are highly consistent from one payment to the next." },
  consistencyModerate: { code: "CONSISTENCY_MODERATE", text: "Payment amounts vary somewhat between payments." },
  consistencyLow: { code: "CONSISTENCY_LOW", text: "Payment amounts vary significantly between payments." },
  frequencyRegular: { code: "FREQUENCY_REGULAR", text: "Payments arrive on a regular schedule, about every 35 days or less." },
  frequencyOccasional: { code: "FREQUENCY_OCCASIONAL", text: "Payments arrive somewhat irregularly, roughly every 36-60 days." },
  frequencySparse: { code: "FREQUENCY_SPARSE", text: "Payments are sparse, roughly every 61-90 days." },
  frequencyInsufficient: { code: "FREQUENCY_INSUFFICIENT", text: "Payments are too infrequent to establish a regular pattern (more than 90 days apart on average)." },
  durationEstablished: { code: "DURATION_ESTABLISHED", text: "Payment history spans 12 months or more." },
  durationModerate: { code: "DURATION_MODERATE", text: "Payment history spans 6 to 11 months." },
  durationLimited: { code: "DURATION_LIMITED", text: "Payment history spans 3 to 5 months." },
  durationInsufficient: { code: "DURATION_INSUFFICIENT", text: "Payment history spans less than 3 months." },
  volumeSubstantial: { code: "VOLUME_SUBSTANTIAL", text: "Total payment volume is $5,000 or more." },
  volumeModerate: { code: "VOLUME_MODERATE", text: "Total payment volume is between $2,000 and $4,999." },
  volumeLow: { code: "VOLUME_LOW", text: "Total payment volume is between $500 and $1,999." },
  volumeMinimal: { code: "VOLUME_MINIMAL", text: "Total payment volume is below $500." },
  insufficientHistory: { code: "INSUFFICIENT_HISTORY", text: "Not enough payment history to compute a meaningful score — at least two payments with nonzero total volume are required." },
} as const;

function insufficientHistoryReasons(weights: typeof WEIGHTS_V1): ScoreReason[] {
  const { code, text } = REASON_CODE_CATALOG.insufficientHistory;
  return [
    { code, factor: "consistency" as const, text, contribution: 0, maxContribution: weights.CONSISTENCY },
    { code, factor: "frequency" as const, text, contribution: 0, maxContribution: weights.FREQUENCY },
    { code, factor: "duration" as const, text, contribution: 0, maxContribution: weights.DURATION },
    { code, factor: "volume" as const, text, contribution: 0, maxContribution: weights.VOLUME },
  ];
}

function scoreWithWeights(analysis: RemittanceAnalysis, weights: typeof WEIGHTS_V1) {
  const totalAmount = parseFloat(analysis.totalAmountUSDC);

  if (analysis.totalPayments <= 1 || totalAmount === 0) {
    return {
      score: 0,
      breakdown: { consistency: 0, frequency: 0, duration: 0, volume: 0 },
      tier: "Insufficient",
      reasons: insufficientHistoryReasons(weights),
    };
  }

  const avgAmount = parseFloat(analysis.averageAmountUSDC);
  const cv = avgAmount > 0 ? analysis.standardDeviation / avgAmount : 1;
  const consistencyScore = Math.max(0, Math.round(weights.CONSISTENCY * (1 - cv)));
  const consistencyRatio = weights.CONSISTENCY > 0 ? consistencyScore / weights.CONSISTENCY : 0;
  const consistencyReason =
    consistencyRatio >= 0.8
      ? REASON_CODE_CATALOG.consistencyHigh
      : consistencyRatio >= 0.4
        ? REASON_CODE_CATALOG.consistencyModerate
        : REASON_CODE_CATALOG.consistencyLow;

  const avgDaysBetween = (analysis.spanMonths * 30) / (analysis.totalPayments - 1);
  let frequencyScore = 0;
  let frequencyReason: Pick<ScoreReason, "code" | "text"> = REASON_CODE_CATALOG.frequencyInsufficient;
  if (avgDaysBetween <= 35) {
    frequencyScore = weights.FREQUENCY;
    frequencyReason = REASON_CODE_CATALOG.frequencyRegular;
  } else if (avgDaysBetween <= 60) {
    frequencyScore = Math.round(weights.FREQUENCY * 0.6);
    frequencyReason = REASON_CODE_CATALOG.frequencyOccasional;
  } else if (avgDaysBetween <= 90) {
    frequencyScore = Math.round(weights.FREQUENCY * 0.2);
    frequencyReason = REASON_CODE_CATALOG.frequencySparse;
  }

  let durationScore = 0;
  let durationReason: Pick<ScoreReason, "code" | "text"> = REASON_CODE_CATALOG.durationInsufficient;
  if (analysis.spanMonths >= 12) {
    durationScore = weights.DURATION;
    durationReason = REASON_CODE_CATALOG.durationEstablished;
  } else if (analysis.spanMonths >= 6) {
    durationScore = Math.round(weights.DURATION * 0.5);
    durationReason = REASON_CODE_CATALOG.durationModerate;
  } else if (analysis.spanMonths >= 3) {
    durationScore = Math.round(weights.DURATION * 0.25);
    durationReason = REASON_CODE_CATALOG.durationLimited;
  }

  let volumeScore = 0;
  let volumeReason: Pick<ScoreReason, "code" | "text"> = REASON_CODE_CATALOG.volumeMinimal;
  if (totalAmount >= 5000) {
    volumeScore = weights.VOLUME;
    volumeReason = REASON_CODE_CATALOG.volumeSubstantial;
  } else if (totalAmount >= 2000) {
    volumeScore = Math.round(weights.VOLUME * 0.66);
    volumeReason = REASON_CODE_CATALOG.volumeModerate;
  } else if (totalAmount >= 500) {
    volumeScore = Math.round(weights.VOLUME * 0.33);
    volumeReason = REASON_CODE_CATALOG.volumeLow;
  }

  const score = consistencyScore + frequencyScore + durationScore + volumeScore;

  let tier = "Insufficient";
  if (score >= 80) {
    tier = "Excellent";
  } else if (score >= 60) {
    tier = "Good";
  } else if (score >= 40) {
    tier = "Fair";
  }

  // Ordered by deficit (max weight minus actual contribution) descending —
  // the factor holding the score back the most comes first, which is the
  // order an adverse-decision notice wants: "here's what to improve."
  const reasons: ScoreReason[] = [
    { ...consistencyReason, factor: "consistency" as const, contribution: consistencyScore, maxContribution: weights.CONSISTENCY },
    { ...frequencyReason, factor: "frequency" as const, contribution: frequencyScore, maxContribution: weights.FREQUENCY },
    { ...durationReason, factor: "duration" as const, contribution: durationScore, maxContribution: weights.DURATION },
    { ...volumeReason, factor: "volume" as const, contribution: volumeScore, maxContribution: weights.VOLUME },
  ].sort((a, b) => (b.maxContribution - b.contribution) - (a.maxContribution - a.contribution));

  return {
    score,
    breakdown: {
      consistency: consistencyScore,
      frequency: frequencyScore,
      duration: durationScore,
      volume: volumeScore,
    },
    tier,
    reasons,
  };
}

export function calculateCreditScore(analysis: RemittanceAnalysis): CreditScoreResult {
  const activeResult = scoreWithWeights(analysis, WEIGHTS_V1);
  let shadowResult: CreditScoreResult["shadowScore"] | undefined;

  if (currentModelConfig.shadowModeEnabled && currentModelConfig.shadowVersion) {
    const shadowCalc = scoreWithWeights(analysis, WEIGHTS_SHADOW);
    shadowResult = {
      modelVersion: currentModelConfig.shadowVersion,
      score: shadowCalc.score,
      tier: shadowCalc.tier,
      breakdown: shadowCalc.breakdown,
    };

    shadowEvaluationsLog.push({
      id: Math.random().toString(36).substring(2, 11),
      timestamp: new Date().toISOString(),
      activeVersion: currentModelConfig.activeVersion,
      activeScore: activeResult.score,
      shadowVersion: currentModelConfig.shadowVersion,
      shadowScore: shadowCalc.score,
      delta: shadowCalc.score - activeResult.score,
    });
  }

  return {
    score: activeResult.score,
    modelVersion: currentModelConfig.activeVersion,
    breakdown: activeResult.breakdown,
    tier: activeResult.tier,
    reasons: activeResult.reasons,
    shadowScore: shadowResult,
  };
}
