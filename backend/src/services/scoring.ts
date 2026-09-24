import { RemittanceAnalysis } from "./stellar.js";

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

function scoreWithWeights(analysis: RemittanceAnalysis, weights: typeof WEIGHTS_V1) {
  const totalAmount = parseFloat(analysis.totalAmountUSDC);

  if (analysis.totalPayments <= 1 || totalAmount === 0) {
    return {
      score: 0,
      breakdown: { consistency: 0, frequency: 0, duration: 0, volume: 0 },
      tier: "Insufficient",
    };
  }

  const avgAmount = parseFloat(analysis.averageAmountUSDC);
  const cv = avgAmount > 0 ? analysis.standardDeviation / avgAmount : 1;
  const consistencyScore = Math.max(0, Math.round(weights.CONSISTENCY * (1 - cv)));

  const avgDaysBetween = (analysis.spanMonths * 30) / (analysis.totalPayments - 1);
  let frequencyScore = 0;
  if (avgDaysBetween <= 35) {
    frequencyScore = weights.FREQUENCY;
  } else if (avgDaysBetween <= 60) {
    frequencyScore = Math.round(weights.FREQUENCY * 0.6);
  } else if (avgDaysBetween <= 90) {
    frequencyScore = Math.round(weights.FREQUENCY * 0.2);
  }

  let durationScore = 0;
  if (analysis.spanMonths >= 12) {
    durationScore = weights.DURATION;
  } else if (analysis.spanMonths >= 6) {
    durationScore = Math.round(weights.DURATION * 0.5);
  } else if (analysis.spanMonths >= 3) {
    durationScore = Math.round(weights.DURATION * 0.25);
  }

  let volumeScore = 0;
  if (totalAmount >= 5000) {
    volumeScore = weights.VOLUME;
  } else if (totalAmount >= 2000) {
    volumeScore = Math.round(weights.VOLUME * 0.66);
  } else if (totalAmount >= 500) {
    volumeScore = Math.round(weights.VOLUME * 0.33);
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

  return {
    score,
    breakdown: {
      consistency: consistencyScore,
      frequency: frequencyScore,
      duration: durationScore,
      volume: volumeScore,
    },
    tier,
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
    shadowScore: shadowResult,
  };
}
