// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { BASE_FEE } from "@stellar/stellar-sdk";
import type { SimulationEstimate } from "./soroban-client";

/**
 * Fee presets derived from a Soroban simulation.
 *
 * A Soroban transaction fee is the resource fee returned by simulation plus an
 * inclusion fee. Under congestion the inclusion component is what decides
 * whether a transaction makes it into the ledger, so the presets scale the
 * simulated minimum rather than replacing it.
 */

export type FeeTier = "standard" | "fast" | "instant";

export const FEE_TIERS: FeeTier[] = ["standard", "fast", "instant"];

/** Multipliers applied to the simulated minimum fee, per tier. */
export const FEE_TIER_MULTIPLIERS: Record<FeeTier, number> = {
  standard: 1,
  fast: 2,
  instant: 5,
};

export const FEE_TIER_LABELS: Record<FeeTier, string> = {
  standard: "Standard",
  fast: "Fast",
  instant: "Instant",
};

export const FEE_TIER_DESCRIPTIONS: Record<FeeTier, string> = {
  standard: "Simulated minimum. Fine when the network is quiet.",
  fast: "2× the minimum. Survives moderate congestion.",
  instant: "5× the minimum. For time-critical submissions.",
};

/** Inclusion fee floor in stroops (network minimum per operation). */
export const INCLUSION_FEE_STROOPS = Number(BASE_FEE);

export type FeeOption = {
  tier: FeeTier;
  label: string;
  description: string;
  /** Max fee for this tier, in stroops. */
  stroops: number;
};

function toPositiveInt(value: string | undefined, fallback = 0): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The baseline max fee for a simulated transaction: the resource fee plus the
 * inclusion fee. Everything else is a multiple of this.
 */
export function baselineFeeStroops(estimate: SimulationEstimate | null): number {
  const resourceFee = toPositiveInt(estimate?.minResourceFeeStroops, 0);
  return resourceFee + INCLUSION_FEE_STROOPS;
}

/** Fee options for the three presets, cheapest first. */
export function buildFeeOptions(estimate: SimulationEstimate | null): FeeOption[] {
  const baseline = baselineFeeStroops(estimate);
  return FEE_TIERS.map((tier) => ({
    tier,
    label: FEE_TIER_LABELS[tier],
    description: FEE_TIER_DESCRIPTIONS[tier],
    stroops: baseline * FEE_TIER_MULTIPLIERS[tier],
  }));
}

/** Slider bounds: never below the simulated minimum, up to 2× the instant tier. */
export function feeSliderRange(estimate: SimulationEstimate | null): {
  min: number;
  max: number;
  step: number;
} {
  const baseline = baselineFeeStroops(estimate);
  const max = baseline * FEE_TIER_MULTIPLIERS.instant * 2;
  const step = Math.max(1, Math.round(baseline / 20));
  return { min: baseline, max, step };
}

/** The preset a custom fee corresponds to, or null when it sits between tiers. */
export function matchFeeTier(
  stroops: number,
  estimate: SimulationEstimate | null
): FeeTier | null {
  const options = buildFeeOptions(estimate);
  return options.find((option) => option.stroops === stroops)?.tier ?? null;
}

/** True when the chosen fee cannot cover the simulated resource fee. */
export function isFeeBelowMinimum(
  stroops: number,
  estimate: SimulationEstimate | null
): boolean {
  if (!estimate) return false;
  const resourceFee = toPositiveInt(estimate.minResourceFeeStroops, 0);
  if (resourceFee === 0) return false;
  return stroops < resourceFee;
}

/** Format a stroop amount as "12,345 stroops (0.0012345 XLM)". */
export function formatFee(stroops: number): string {
  if (!Number.isFinite(stroops) || stroops <= 0) return "—";
  const xlm = stroops / 10_000_000;
  return `${stroops.toLocaleString()} stroops (${xlm.toFixed(7)} XLM)`;
}

/** Convert a stroop amount to a USD estimate, when an XLM price is known. */
export function feeToUsd(stroops: number, xlmPriceUsd: number | null): string | null {
  if (!xlmPriceUsd || !Number.isFinite(stroops) || stroops <= 0) return null;
  return ((stroops / 10_000_000) * xlmPriceUsd).toFixed(4);
}
