// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Regression tests for cross-tranche rounding dust accumulation (issue #735).
 *
 * Fixed-point waterfall division floors each tranche payout, leaving dust.
 * These tests run long sequences with dust-maximizing amounts and assert the
 * conservation invariant every cycle: sum(payouts) + tracked dust === total.
 * Dust handling (sweep vs carry-forward) is asserted explicitly, and a
 * fuzz/property test varies amounts and tranche counts beyond hand-picked
 * values.
 */

import * as fc from "fast-check";
import { distributeWaterfall, TrancheDustLedger } from "../services/trancheDistribution.js";

describe("tranche waterfall dust accounting (issue #735)", () => {
  it("never loses value over a long dust-maximizing sequence (sweep-treasury)", () => {
    const ledger = new TrancheDustLedger("sweep-treasury");
    const weights = [1n, 1n, 1n]; // thirds maximize remainders
    let swept = 0n;
    let distributed = 0n;
    let paid = 0n;
    // Amounts chosen to maximize rounding remainders: total % 3 !== 0.
    for (let cycle = 0; cycle < 1000; cycle++) {
      const total = BigInt(10_000_001 + ((cycle * 7) % 5));
      const r = ledger.distribute(total, weights);
      // Explicit dust behavior: swept, not dropped.
      expect(r.dust).toBe(r.treasuryDust);
      expect(r.carriedDust).toBe(0n);
      expect(r.payouts.reduce((a, b) => a + b, 0n) + r.dust).toBe(total);
      swept += r.treasuryDust;
      distributed += total;
      paid += r.payouts.reduce((a, b) => a + b, 0n);
    }
    expect(paid + swept).toBe(distributed);
    expect(ledger.sweptDustTotal).toBe(swept);
    expect(ledger.accountedTotal).toBe(ledger.totals.distributed);
  });

  it("carry-forward policy recycles dust into later cycles without loss", () => {
    const ledger = new TrancheDustLedger("carry-forward");
    const weights = [3n, 2n, 1n, 1n]; // 7-way split-ish weights
    let distributed = 0n;
    let paid = 0n;
    for (let cycle = 0; cycle < 500; cycle++) {
      const total = BigInt(1_000_003 + ((cycle * 13) % 11));
      const r = ledger.distribute(total, weights);
      expect(r.dust).toBe(r.carriedDust);
      expect(r.treasuryDust).toBe(0n);
      // Per-cycle conservation: payouts + tracked dust covers at least the
      // fresh total (carry only grows the effective amount, never shrinks it).
      expect(r.payouts.reduce((a, b) => a + b, 0n) + r.dust).toBeGreaterThanOrEqual(total);
      distributed += total;
      paid += r.payouts.reduce((a, b) => a + b, 0n);
    }
    // Global conservation: everything distributed is either paid or still carried.
    expect(paid + ledger.carriedDust).toBe(distributed);
  });

  it("single-cycle dust equals total minus floored payouts (explicit, not implicit)", () => {
    const r = distributeWaterfall(100n, [1n, 1n, 1n], "sweep-treasury");
    expect(r.payouts).toEqual([33n, 33n, 33n]);
    expect(r.dust).toBe(1n);
    expect(r.treasuryDust).toBe(1n);
  });

  it("fuzz: payouts + dust always equals total for arbitrary amounts/tranches", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 8 }),
        fc.constantFrom("sweep-treasury", "carry-forward") as fc.Arbitrary<"sweep-treasury" | "carry-forward">,
        (totalNum, weightNums, policy) => {
          if (weightNums.every((w) => w === 0)) return;
          const total = BigInt(totalNum);
          const weights = weightNums.map((w) => BigInt(w));
          const r = distributeWaterfall(total, weights, policy);
          const paid = r.payouts.reduce((a, b) => a + b, 0n);
          // Conservation invariant at every step.
          expect(paid + r.dust).toBe(total);
          // Explicit policy accounting.
          if (policy === "sweep-treasury") {
            expect(r.treasuryDust).toBe(r.dust);
            expect(r.carriedDust).toBe(0n);
          } else {
            expect(r.carriedDust).toBe(r.dust);
            expect(r.treasuryDust).toBe(0n);
          }
          // Dust is bounded: strictly less than tranche count.
          expect(r.dust).toBeLessThan(BigInt(weights.length));
          expect(r.dust).toBeGreaterThanOrEqual(0n);
        }
      ),
      { numRuns: 500 }
    );
  });
});
