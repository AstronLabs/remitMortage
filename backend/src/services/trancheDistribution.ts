// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Cross-tranche waterfall distribution with explicit rounding-dust accounting
 * (issue #735).
 *
 * Fixed-point division (`floor(total * weight / totalWeight)`) leaves a
 * remainder ("dust") of `< trancheCount` stroops per cycle. Over many cycles
 * silently dropped dust accumulates into a real discrepancy. This module is
 * the canonical off-chain mirror of the on-chain waterfall (see
 * `contracts/lending-pool/src/lib.rs` yield waterfall and
 * `contracts/staking-pool/src/lib.rs` distribute_rewards): every cycle
 * returns payouts PLUS tracked dust such that
 * `sum(payouts) + dust === total` always holds.
 *
 * Dust policy (explicit, never implicit):
 * - `sweep-treasury`: dust is swept to a defined destination (treasury) each
 *   cycle and reported as `treasuryDust`.
 * - `carry-forward`: dust is carried into the next cycle's distributable
 *   total via {@link TrancheDustLedger} and reported as `carriedDust`.
 */

export type DustPolicy = "sweep-treasury" | "carry-forward";

export interface WaterfallResult {
  payouts: bigint[];
  /** Rounding remainder for this cycle: total - sum(payouts). Always >= 0. */
  dust: bigint;
  /** Dust swept to treasury this cycle (sweep-treasury policy). */
  treasuryDust: bigint;
  /** Dust carried into the next cycle (carry-forward policy). */
  carriedDust: bigint;
}

/**
 * Single fixed-point waterfall split. Pure function over bigints so rounding
 * is exact and testable. Mirrors on-chain `(amount * share) / total` floors.
 */
export function distributeWaterfall(
  total: bigint,
  weights: bigint[],
  policy: DustPolicy = "sweep-treasury"
): WaterfallResult {
  if (total < 0n) throw new Error("total must be non-negative");
  if (weights.length === 0) throw new Error("at least one tranche weight is required");
  if (weights.some((w) => w < 0n)) throw new Error("weights must be non-negative");

  const totalWeight = weights.reduce((a, b) => a + b, 0n);
  if (totalWeight <= 0n) {
    return { payouts: weights.map(() => 0n), dust: total, treasuryDust: policy === "sweep-treasury" ? total : 0n, carriedDust: policy === "carry-forward" ? total : 0n };
  }

  const payouts = weights.map((w) => (total * w) / totalWeight);
  const paid = payouts.reduce((a, b) => a + b, 0n);
  const dust = total - paid;
  return {
    payouts,
    dust,
    treasuryDust: policy === "sweep-treasury" ? dust : 0n,
    carriedDust: policy === "carry-forward" ? dust : 0n,
  };
}

/**
 * Stateful ledger for the carry-forward policy across many distribution
 * cycles. Swept totals are tracked separately for the sweep policy.
 */
export class TrancheDustLedger {
  private carried = 0n;
  private sweptTotal = 0n;
  private distributedTotal = 0n;
  private paidTotal = 0n;

  constructor(private readonly policy: DustPolicy = "sweep-treasury") {}

  distribute(total: bigint, weights: bigint[]): WaterfallResult {
    const effective = total + (this.policy === "carry-forward" ? this.carried : 0n);
    const result = distributeWaterfall(effective, weights, this.policy);
    if (this.policy === "carry-forward") {
      this.carried = result.carriedDust;
    } else {
      this.sweptTotal += result.treasuryDust;
    }
    this.distributedTotal += effective;
    this.paidTotal += result.payouts.reduce((a, b) => a + b, 0n);
    return result;
  }

  get carriedDust(): bigint {
    return this.carried;
  }

  get sweptDustTotal(): bigint {
    return this.sweptTotal;
  }

  /** Conservation invariant: paid + (swept|carried) === distributed. */
  get accountedTotal(): bigint {
    return this.paidTotal + this.sweptTotal + this.carried;
  }

  get totals(): { distributed: bigint; paid: bigint; swept: bigint; carried: bigint } {
    return { distributed: this.distributedTotal, paid: this.paidTotal, swept: this.sweptTotal, carried: this.carried };
  }
}
