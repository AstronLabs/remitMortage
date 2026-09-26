// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Side-by-side loan offer comparison.
 *
 * Builds on `@/lib/amortization`, which mirrors the LendingPool's own
 * flat-interest schedule, so a scenario's monthly payment and total interest
 * are the figures the contract would actually charge rather than an
 * independent estimate that could drift from it.
 *
 * All money is handled in bigint stroops for the same reason it is there: the
 * on-chain arithmetic is integer, and comparing offers on floats would let
 * rounding decide which scenario looks cheaper.
 */

import {
  calculateMonthlyPayment,
  calculateTotalInterest,
  toStroops,
  STROOPS_PER_UNIT,
} from "./amortization";

/** The comparison table holds at most three scenarios side by side. */
export const MAX_SCENARIOS = 3;

/** Savings-plan durations the onboarding wizard accepts. */
export const SAVINGS_DURATIONS = [6, 9, 12] as const;
export type SavingsDuration = (typeof SAVINGS_DURATIONS)[number];

/** One configurable loan offer being evaluated. */
export interface LoanScenario {
  id: string;
  /** Short user-facing name, e.g. "Offer A". */
  label: string;
  /** Full property price, in whole tokens. */
  propertyValue: number;
  /** Share of the price the borrower puts down (the collateral), in percent. */
  downPaymentPct: number;
  /** Annual interest rate in basis points. */
  interestRateBps: number;
  /** Repayment term in months. */
  termMonths: number;
  /** How long the borrower plans to save the down payment. */
  savingsMonths: SavingsDuration;
}

/** Derived figures for a single scenario, all in stroops unless noted. */
export interface ScenarioMetrics {
  scenario: LoanScenario;
  /** Cash the borrower must save before borrowing. */
  downPayment: bigint;
  /** Amount financed by the lending pool. */
  principal: bigint;
  /** Loan-to-value in basis points. */
  ltvBps: number;
  /** What the borrower must set aside each month to hit the down payment. */
  monthlySavings: bigint;
  monthlyPayment: bigint;
  totalInterest: bigint;
  /** Principal + interest. */
  totalRepayment: bigint;
  /** Everything the property costs: down payment plus all repayments. */
  totalCost: bigint;
}

/** A scenario's metrics plus how it stacks up against the baseline. */
export interface ScenarioComparison extends ScenarioMetrics {
  isBaseline: boolean;
  /** Negative means cheaper than the baseline. */
  monthlyDelta: bigint;
  totalInterestDelta: bigint;
  totalCostDelta: bigint;
  /** Lowest monthly payment in the set (ties all flagged). */
  isLowestMonthly: boolean;
  /** Lowest total interest in the set (ties all flagged). */
  isLowestInterest: boolean;
}

/** Basis-point scale, as a number for ratio maths on percentages. */
const BPS = 10_000;

let scenarioCounter = 0;

/**
 * Mints a scenario with sensible starting values.
 *
 * IDs are generated locally because scenarios never leave the browser — they
 * are a scratchpad for the borrower, not a persisted server record.
 */
export function createScenario(overrides: Partial<LoanScenario> = {}): LoanScenario {
  scenarioCounter += 1;
  return {
    id:
      overrides.id ??
      `scenario-${Date.now().toString(36)}-${scenarioCounter.toString(36)}`,
    label: overrides.label ?? `Offer ${String.fromCharCode(64 + scenarioCounter)}`,
    propertyValue: overrides.propertyValue ?? 50_000,
    downPaymentPct: overrides.downPaymentPct ?? 30,
    interestRateBps: overrides.interestRateBps ?? 800,
    termMonths: overrides.termMonths ?? 12,
    savingsMonths: overrides.savingsMonths ?? 12,
  };
}

/** Clamps a scenario's fields to ranges the protocol and UI can represent. */
export function normalizeScenario(scenario: LoanScenario): LoanScenario {
  const propertyValue = Math.max(0, scenario.propertyValue || 0);
  const downPaymentPct = Math.min(100, Math.max(0, scenario.downPaymentPct || 0));
  const interestRateBps = Math.min(
    10_000,
    Math.max(0, Math.trunc(scenario.interestRateBps || 0))
  );
  const termMonths = Math.max(1, Math.trunc(scenario.termMonths || 1));

  return { ...scenario, propertyValue, downPaymentPct, interestRateBps, termMonths };
}

/**
 * Derives every headline figure for one scenario.
 *
 * The down payment is computed in stroops and the principal by subtraction, so
 * the two always add back to exactly the property value — no stray stroop from
 * rounding the split twice.
 */
export function computeScenarioMetrics(input: LoanScenario): ScenarioMetrics {
  const scenario = normalizeScenario(input);

  const propertyValue = toStroops(scenario.propertyValue);
  const downPayment =
    (propertyValue * BigInt(Math.round(scenario.downPaymentPct * 100))) / BigInt(BPS);
  const principal = propertyValue - downPayment;

  const ltvBps =
    propertyValue > 0n ? Number((principal * BigInt(BPS)) / propertyValue) : 0;

  const monthlySavings =
    scenario.savingsMonths > 0 ? downPayment / BigInt(scenario.savingsMonths) : 0n;

  const totalInterest = calculateTotalInterest(principal, scenario.interestRateBps);
  const monthlyPayment = calculateMonthlyPayment(
    principal,
    scenario.interestRateBps,
    scenario.termMonths
  );
  const totalRepayment = principal + totalInterest;

  return {
    scenario,
    downPayment,
    principal,
    ltvBps,
    monthlySavings,
    monthlyPayment,
    totalInterest,
    totalRepayment,
    totalCost: downPayment + totalRepayment,
  };
}

/** Smallest value in a list, or 0n when empty. */
function minOf(values: bigint[]): bigint {
  return values.reduce(
    (lowest, value) => (value < lowest ? value : lowest),
    values[0] ?? 0n
  );
}

/**
 * Computes metrics for every scenario and the deltas against a baseline.
 *
 * The baseline defaults to the first scenario — the borrower's current pick —
 * so deltas read as "what changes if I switch to this instead". Passing an
 * unknown `baselineId` falls back to the first rather than producing deltas
 * against nothing.
 */
export function compareScenarios(
  scenarios: LoanScenario[],
  baselineId?: string
): ScenarioComparison[] {
  if (scenarios.length === 0) return [];

  const metrics = scenarios.map(computeScenarioMetrics);
  const baseline =
    metrics.find((entry) => entry.scenario.id === baselineId) ?? metrics[0];

  const lowestMonthly = minOf(metrics.map((entry) => entry.monthlyPayment));
  const lowestInterest = minOf(metrics.map((entry) => entry.totalInterest));

  return metrics.map((entry) => ({
    ...entry,
    isBaseline: entry.scenario.id === baseline.scenario.id,
    monthlyDelta: entry.monthlyPayment - baseline.monthlyPayment,
    totalInterestDelta: entry.totalInterest - baseline.totalInterest,
    totalCostDelta: entry.totalCost - baseline.totalCost,
    isLowestMonthly: entry.monthlyPayment === lowestMonthly,
    isLowestInterest: entry.totalInterest === lowestInterest,
  }));
}

/** Onboarding wizard fields a selected scenario maps onto. */
export interface OnboardingPrefill {
  savingsTarget: number;
  savingsDuration: SavingsDuration;
  firstDepositAmount: number;
}

/**
 * Translates a scenario into the wizard's own fields.
 *
 * The wizard is about accumulating the down payment, so the savings target is
 * the scenario's down payment — not the property price — and the suggested
 * first deposit is one month of that plan.
 */
export function scenarioToOnboarding(scenario: LoanScenario): OnboardingPrefill {
  const metrics = computeScenarioMetrics(scenario);
  const toWholeTokens = (stroops: bigint) =>
    Number(stroops) / Number(STROOPS_PER_UNIT);

  return {
    savingsTarget: Math.round(toWholeTokens(metrics.downPayment)),
    savingsDuration: scenario.savingsMonths,
    firstDepositAmount: Math.round(toWholeTokens(metrics.monthlySavings)),
  };
}

/** Renders a signed stroop delta, e.g. "+12.50" / "−8.00" / "—". */
export function formatDelta(
  delta: bigint,
  format: (value: bigint) => string
): string {
  if (delta === 0n) return "—";
  const sign = delta > 0n ? "+" : "−";
  const magnitude = delta < 0n ? -delta : delta;
  return `${sign}${format(magnitude)}`;
}
