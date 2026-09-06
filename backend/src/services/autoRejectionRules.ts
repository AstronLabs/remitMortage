import type { AutoRejectionRuleType, VerificationStatus } from "@prisma/client";

export type RuleConfig =
  | { minCreditScore: number }
  | { maxRatio: number }
  | { requiredStatus: VerificationStatus };

export interface ApplicantSnapshot {
  verificationStatus: VerificationStatus;
  creditScore: number | null;
  monthlyIncome: number | null;
}

export interface AutoRejectionRuleRecord {
  id: string;
  name: string;
  ruleType: AutoRejectionRuleType;
  config: RuleConfig;
  active: boolean;
  priority: number;
}

export interface RuleEvaluationFailure {
  ruleId: string;
  ruleName: string;
  ruleType: AutoRejectionRuleType;
  reason: string;
}

export interface RuleEvaluationResult {
  rejected: boolean;
  failures: RuleEvaluationFailure[];
}

function parseMonthlyIncome(raw: string | null | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function estimateDebtToIncomeRatio(principal: number, monthlyIncome: number): number {
  // Simplified annualized DTI proxy for baseline screening.
  const estimatedAnnualDebtService = principal * 0.12;
  const annualIncome = monthlyIncome * 12;
  return estimatedAnnualDebtService / annualIncome;
}

export function evaluateRule(
  rule: AutoRejectionRuleRecord,
  applicant: ApplicantSnapshot,
  principal: number
): RuleEvaluationFailure | null {
  const config = rule.config as RuleConfig;

  switch (rule.ruleType) {
    case "MIN_CREDIT_SCORE": {
      const min = (config as { minCreditScore: number }).minCreditScore;
      if (applicant.creditScore == null || applicant.creditScore < min) {
        return {
          ruleId: rule.id,
          ruleName: rule.name,
          ruleType: rule.ruleType,
          reason: `Credit score ${applicant.creditScore ?? "unknown"} is below the minimum required score of ${min}.`,
        };
      }
      return null;
    }
    case "MAX_DEBT_TO_INCOME": {
      const maxRatio = (config as { maxRatio: number }).maxRatio;
      const income = applicant.monthlyIncome;
      if (income == null) {
        return {
          ruleId: rule.id,
          ruleName: rule.name,
          ruleType: rule.ruleType,
          reason: "Monthly income is required to evaluate debt-to-income eligibility.",
        };
      }
      const ratio = estimateDebtToIncomeRatio(principal, income);
      if (ratio > maxRatio) {
        return {
          ruleId: rule.id,
          ruleName: rule.name,
          ruleType: rule.ruleType,
          reason: `Estimated debt-to-income ratio ${(ratio * 100).toFixed(1)}% exceeds the maximum allowed ${(maxRatio * 100).toFixed(1)}%.`,
        };
      }
      return null;
    }
    case "REQUIRES_VERIFICATION": {
      const requiredStatus = (config as { requiredStatus: VerificationStatus }).requiredStatus;
      if (applicant.verificationStatus !== requiredStatus) {
        return {
          ruleId: rule.id,
          ruleName: rule.name,
          ruleType: rule.ruleType,
          reason: `Verification status must be ${requiredStatus}; current status is ${applicant.verificationStatus}.`,
        };
      }
      return null;
    }
    default:
      return null;
  }
}

export function evaluateApplicantAgainstRules(
  rules: AutoRejectionRuleRecord[],
  applicant: ApplicantSnapshot,
  principal: number
): RuleEvaluationResult {
  const failures: RuleEvaluationFailure[] = [];

  for (const rule of rules) {
    if (!rule.active) continue;
    const failure = evaluateRule(rule, applicant, principal);
    if (failure) failures.push(failure);
  }

  return { rejected: failures.length > 0, failures };
}

export function applicantSnapshotFromRecord(applicant: {
  verificationStatus: VerificationStatus;
  creditScore: number | null;
  monthlyIncome: string | null;
}): ApplicantSnapshot {
  return {
    verificationStatus: applicant.verificationStatus,
    creditScore: applicant.creditScore,
    monthlyIncome: parseMonthlyIncome(applicant.monthlyIncome),
  };
}

export function formatAutoRejectionReason(failures: RuleEvaluationFailure[]): string {
  if (failures.length === 1) return failures[0].reason;
  return failures.map((f, i) => `${i + 1}. ${f.reason}`).join(" ");
}
