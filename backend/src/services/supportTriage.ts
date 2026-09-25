// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

export type RiskTier = "HIGH" | "MEDIUM" | "LOW";
export type PriorityLevel = "URGENT" | "HIGH" | "NORMAL" | "LOW";
export type SupportQueue =
  | "urgent-mortgage"
  | "senior-mortgage"
  | "standard"
  | "general";

export interface TriageRule {
  id: string;
  name: string;
  /** Applicant risk tier this rule targets; omit to match any tier. */
  riskTier?: RiskTier;
  /** Minimum loan amount (USD) required to trigger this rule. */
  minLoanAmount?: number;
  /** Maximum days until the application deadline that triggers urgency. */
  maxDaysToDeadline?: number;
  priority: PriorityLevel;
  suggestedQueue: SupportQueue;
  active: boolean;
}

export interface TicketInput {
  id: string;
  riskTier?: RiskTier;
  /** Loan principal amount in USD. */
  loanAmount?: number;
  /** Calendar days remaining until the application deadline. */
  daysToDeadline?: number;
}

export interface TriageResult {
  ticketId: string;
  priority: PriorityLevel;
  suggestedQueue: SupportQueue;
  matchedRuleId: string | null;
  matchedRuleName: string | null;
  autoTriagedAt: Date;
}

export interface PriorityOverride {
  ticketId: string;
  previousPriority: PriorityLevel;
  newPriority: PriorityLevel;
  staffId: string;
  reason: string;
  overriddenAt: Date;
}

export interface OverriddenTriageResult extends TriageResult {
  override: PriorityOverride;
}

// Priority order: lower index = higher urgency
const PRIORITY_ORDER: PriorityLevel[] = ["URGENT", "HIGH", "NORMAL", "LOW"];

export const DEFAULT_TRIAGE_RULES: TriageRule[] = [
  {
    id: "rule-high-tier-deadline",
    name: "High-risk applicant near deadline",
    riskTier: "HIGH",
    maxDaysToDeadline: 7,
    priority: "URGENT",
    suggestedQueue: "urgent-mortgage",
    active: true,
  },
  {
    id: "rule-high-tier",
    name: "High-risk applicant",
    riskTier: "HIGH",
    priority: "HIGH",
    suggestedQueue: "senior-mortgage",
    active: true,
  },
  {
    id: "rule-large-loan-deadline",
    name: "Large loan nearing deadline",
    minLoanAmount: 500_000,
    maxDaysToDeadline: 14,
    priority: "HIGH",
    suggestedQueue: "senior-mortgage",
    active: true,
  },
  {
    id: "rule-medium-tier",
    name: "Medium-risk applicant",
    riskTier: "MEDIUM",
    priority: "NORMAL",
    suggestedQueue: "standard",
    active: true,
  },
];

function ruleMatches(rule: TriageRule, ticket: TicketInput): boolean {
  if (!rule.active) return false;

  if (rule.riskTier !== undefined && ticket.riskTier !== rule.riskTier) {
    return false;
  }

  if (
    rule.minLoanAmount !== undefined &&
    (ticket.loanAmount === undefined || ticket.loanAmount < rule.minLoanAmount)
  ) {
    return false;
  }

  if (
    rule.maxDaysToDeadline !== undefined &&
    (ticket.daysToDeadline === undefined ||
      ticket.daysToDeadline > rule.maxDaysToDeadline)
  ) {
    return false;
  }

  return true;
}

/**
 * Applies triage rules to a support ticket and returns the highest-priority
 * match.  When no rule matches the ticket falls through to NORMAL / general.
 */
export function triageTicket(
  ticket: TicketInput,
  rules: TriageRule[] = DEFAULT_TRIAGE_RULES
): TriageResult {
  let bestRule: TriageRule | null = null;
  let bestIdx = Infinity;

  for (const rule of rules) {
    if (!ruleMatches(rule, ticket)) continue;
    const idx = PRIORITY_ORDER.indexOf(rule.priority);
    if (idx < bestIdx) {
      bestIdx = idx;
      bestRule = rule;
    }
  }

  return {
    ticketId: ticket.id,
    priority: bestRule?.priority ?? "NORMAL",
    suggestedQueue: bestRule?.suggestedQueue ?? "general",
    matchedRuleId: bestRule?.id ?? null,
    matchedRuleName: bestRule?.name ?? null,
    autoTriagedAt: new Date(),
  };
}

/**
 * Records a staff member's manual priority override on a triage result.
 * The override survives subsequent auto-triage re-runs because it is stored
 * separately from the auto-assigned result; callers should persist the
 * returned {@link PriorityOverride} record and apply it after any re-triage.
 */
export function overridePriority(
  result: TriageResult,
  newPriority: PriorityLevel,
  staffId: string,
  reason: string
): PriorityOverride {
  return {
    ticketId: result.ticketId,
    previousPriority: result.priority,
    newPriority,
    staffId,
    reason,
    overriddenAt: new Date(),
  };
}

/**
 * Merges an override onto a (potentially re-triaged) result, producing a
 * final effective result that reflects the manual decision.
 */
export function applyOverride(
  result: TriageResult,
  override: PriorityOverride
): OverriddenTriageResult {
  return { ...result, priority: override.newPriority, override };
}
