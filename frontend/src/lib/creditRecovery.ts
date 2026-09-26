// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

export type CreditTier = "Excellent" | "Good" | "Fair" | "Insufficient";

export interface CreditScoreSnapshot {
  date: string;
  score: number;
  tier: CreditTier;
  label: string;
}

export interface PaymentMilestone {
  month: number;
  label: string;
  scoreImprovement: number;
  projectedScore: number;
  projectedTier: CreditTier;
  projectedRate: number;
  isRequired: boolean;
}

export interface CreditRecoveryPlan {
  currentScore: number;
  currentTier: CreditTier;
  currentRate: number;
  history: CreditScoreSnapshot[];
  milestones: PaymentMilestone[];
  targetTier: CreditTier;
  targetScore: number;
  monthsToTarget: number;
  missedPayments: number;
  consecutiveLate: number;
  onTimePayments: number;
}

export const TIER_CONFIG: Record<CreditTier, { min: number; rate: number; color: string; label: string }> = {
  Excellent: { min: 80, rate: 3.5, color: "#10b981", label: "Excellent — lowest rates" },
  Good: { min: 60, rate: 4.8, color: "#06b6d4", label: "Good — competitive rates" },
  Fair: { min: 40, rate: 6.2, color: "#f59e0b", label: "Fair — moderate rates" },
  Insufficient: { min: 0, rate: 8.5, color: "#ef4444", label: "Insufficient — high rates" },
};

export function getTier(score: number): CreditTier {
  if (score >= 80) return "Excellent";
  if (score >= 60) return "Good";
  if (score >= 40) return "Fair";
  return "Insufficient";
}

export function getRate(score: number): number {
  return TIER_CONFIG[getTier(score)].rate;
}

function generateMockHistory(): CreditScoreSnapshot[] {
  const now = new Date();
  const history: CreditScoreSnapshot[] = [];
  const baseScore = 32;
  for (let i = 6; i >= 1; i--) {
    const d = new Date(now);
    d.setMonth(d.getMonth() - i);
    const score = Math.max(0, Math.min(100, baseScore + Math.round(Math.random() * 15 - 5)));
    history.push({
      date: d.toISOString().slice(0, 7),
      score,
      tier: getTier(score),
      label: i === 1 ? "Last month" : `${i} months ago`,
    });
  }
  return history;
}

export function generateRecoveryPlan(params: {
  currentScore?: number;
  missedPayments?: number;
  consecutiveLate?: number;
  onTimePayments?: number;
  monthlyPayment?: number;
}): CreditRecoveryPlan {
  const currentScore = params.currentScore ?? 35;
  const missedPayments = params.missedPayments ?? 2;
  const consecutiveLate = params.consecutiveLate ?? 1;
  const onTimePayments = params.onTimePayments ?? 8;
  const monthlyPayment = params.monthlyPayment ?? 500;

  const currentTier = getTier(currentScore);
  const currentRate = getRate(currentScore);

  const history = generateMockHistory();

  let projectedScore = currentScore;
  const milestones: PaymentMilestone[] = [];
  let targetTier: CreditTier = "Excellent";
  let monthsToTarget = 0;

  for (let month = 1; month <= 12; month++) {
    const scoreImprovement = calculateMonthImprovement(
      projectedScore,
      monthlyPayment,
      month === 1 && missedPayments > 0
    );

    projectedScore = Math.min(100, projectedScore + scoreImprovement);
    const projectedTier = getTier(projectedScore);
    const projectedRate = getRate(projectedScore);

    milestones.push({
      month,
      label: getMilestoneLabel(month),
      scoreImprovement,
      projectedScore,
      projectedTier,
      projectedRate,
      isRequired: month <= missedPayments + 2,
    });

    if (projectedTier !== currentTier && monthsToTarget === 0 && month > missedPayments) {
      targetTier = projectedTier;
      monthsToTarget = month;
    }
  }

  if (monthsToTarget === 0) {
    monthsToTarget = 12;
  }

  return {
    currentScore,
    currentTier,
    currentRate,
    history,
    milestones,
    targetTier: getTier(projectedScore),
    targetScore: projectedScore,
    monthsToTarget: milestones.find((m) => m.projectedTier !== currentTier)?.month ?? 12,
    missedPayments,
    consecutiveLate,
    onTimePayments,
  };
}

function calculateMonthImprovement(currentScore: number, _monthlyPayment: number, isFirstMonthAndMissed: boolean): number {
  if (isFirstMonthAndMissed) {
    return 0;
  }
  const baseImprovement = 4;
  const diminishingFactor = Math.max(0.3, 1 - currentScore / 120);
  return Math.round(baseImprovement * diminishingFactor);
}

function getMilestoneLabel(month: number): string {
  if (month === 1) return "Month 1";
  if (month === 3) return "Quarter 1 review";
  if (month === 6) return "Semi-annual review";
  if (month === 9) return "Quarter 3 review";
  if (month === 12) return "Annual review";
  if (month % 3 === 0) return `Month ${month} review`;
  return `Month ${month}`;
}

export function getBorrowerAlert(plan: CreditRecoveryPlan): {
  type: "CREDIT_SCORE_DROP" | "CREDIT_RECOVERY_ON_TRACK" | "CREDIT_IMPROVEMENT_NEAR" | null;
  title: string;
  message: string;
} | null {
  if (plan.currentTier === "Insufficient" && plan.missedPayments > 0) {
    return {
      type: "CREDIT_SCORE_DROP",
      title: "Credit score recovery plan active",
      message: `Your score is ${plan.currentScore} (${plan.currentTier}). On-time payments rebuild ${plan.milestones[0]?.projectedScore ?? "toward"} points.`,
    };
  }

  if (plan.targetTier !== plan.currentTier && plan.monthsToTarget <= 3) {
    return {
      type: "CREDIT_IMPROVEMENT_NEAR",
      title: `${plan.targetTier} tier within reach`,
      message: `${plan.monthsToTarget} months of consistent payments to reach ${plan.targetTier} tier (${plan.targetScore} pts) at ${TIER_CONFIG[plan.targetTier].rate}% APR.`,
    };
  }

  if (plan.missedPayments === 0 && plan.onTimePayments >= 6) {
    return {
      type: "CREDIT_RECOVERY_ON_TRACK",
      title: "Credit recovery on track",
      message: `No missed payments. Score ${plan.currentScore}. ${plan.monthsToTarget} months to next tier.`,
    };
  }

  return null;
}
