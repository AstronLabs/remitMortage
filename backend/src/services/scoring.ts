import { RemittanceAnalysis } from "./stellar.js";

export interface CreditScoreResult {
  score: number;
  breakdown: {
    consistency: number;
    frequency: number;
    duration: number;
    volume: number;
  };
  tier: string;
}

const WEIGHTS = {
  CONSISTENCY: 40,
  FREQUENCY: 25,
  DURATION: 20,
  VOLUME: 15,
};

export function calculateCreditScore(analysis: RemittanceAnalysis): CreditScoreResult {
  const totalAmount = parseFloat(analysis.totalAmountUSDC);

  // Edge cases: single payment or zero volume
  if (analysis.totalPayments <= 1 || totalAmount === 0) {
    return {
      score: 0,
      breakdown: { consistency: 0, frequency: 0, duration: 0, volume: 0 },
      tier: "Insufficient",
    };
  }

  // Consistency (Max 40)
  // Uses Coefficient of Variation (CV = stdDev / mean)
  // Lower CV = better consistency. If CV >= 1, consistency is 0.
  const avgAmount = parseFloat(analysis.averageAmountUSDC);
  const cv = avgAmount > 0 ? analysis.standardDeviation / avgAmount : 1;
  const consistencyScore = Math.max(0, Math.round(WEIGHTS.CONSISTENCY * (1 - cv)));

  // Frequency (Max 25)
  // Ideal frequency is ~30 days (1 payment per month) or more often.
  // Average days between payments = (spanMonths * 30) / (totalPayments - 1)
  const avgDaysBetween = (analysis.spanMonths * 30) / (analysis.totalPayments - 1);
  let frequencyScore = 0;
  if (avgDaysBetween <= 35) {
    frequencyScore = WEIGHTS.FREQUENCY;
  } else if (avgDaysBetween <= 60) {
    frequencyScore = 15;
  } else if (avgDaysBetween <= 90) {
    frequencyScore = 5;
  }

  // Duration (Max 20)
  // Reward longer history
  let durationScore = 0;
  if (analysis.spanMonths >= 12) {
    durationScore = WEIGHTS.DURATION;
  } else if (analysis.spanMonths >= 6) {
    durationScore = 10;
  } else if (analysis.spanMonths >= 3) {
    durationScore = 5;
  }

  // Volume (Max 15)
  // Reward higher cumulative volume
  let volumeScore = 0;
  if (totalAmount >= 5000) {
    volumeScore = WEIGHTS.VOLUME;
  } else if (totalAmount >= 2000) {
    volumeScore = 10;
  } else if (totalAmount >= 500) {
    volumeScore = 5;
  }

  const score = consistencyScore + frequencyScore + durationScore + volumeScore;

  // Tier Classification
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
