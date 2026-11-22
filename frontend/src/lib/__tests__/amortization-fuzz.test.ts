// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Fuzz tests for amortization schedule generation.
 *
 * The existing suites (`amortization.test.ts`, `amortization-rounding.test.ts`)
 * verify a handful of hand-picked principal, rate and term combinations. This
 * suite generates random but valid inputs within the contract's enforced
 * bounds and asserts the invariants that must hold for *any* valid schedule:
 *
 *   1. Payments sum to principal plus total interest.
 *   2. No row carries a negative balance.
 *   3. The final payment zeroes the balance exactly.
 *
 * The PRNG is seeded so every CI run exercises the same inputs; a failure can
 * be reproduced exactly and the offending combination recorded below as a
 * fixed regression test case.
 */

import {
  buildAmortizationSchedule,
  calculateMonthlyPayment,
  calculateTotalInterest,
  STROOPS_PER_UNIT,
} from "../amortization";

// ── Contract-enforced bounds ──────────────────────────────────────────
//
// The LendingPool contract (`contracts/lending-pool/src/lib.rs`) enforces:
//   - principal > 0  (rejects <= 0 with `PoolError::InvalidAmount`)
//   - rate is a positive basis-point figure (tier values 400/600/800/1200
//     bps, or a pool-configured rate; refinance floor is 200 bps)
//   - term is a positive month count (origination fixes it at
//     `DEFAULT_DURATION_MONTHS = 12`; restructure / refinance / extension
//     can change it; the UI slider allows 6-36)
//
// The frontend library (`amortization.ts`) mirrors these with the only hard
// guards being principal > 0, rate > 0, term > 0 (after `Math.trunc`). We fuzz
// across a broad band that covers the realistic contract values *and* the
// extreme / oddly-shaped terms the issue calls out, all staying within the
// space the function accepts as valid.

/** Smallest expressible loan: one stroop. */
const MIN_PRINCIPAL_STROOPS = 1n;

/** 100 000 USDC — well above any realistic single loan, exercises large inputs. */
const MAX_PRINCIPAL_STROOPS = 100_000n * STROOPS_PER_UNIT;

/** 1 bp (0.01 %) — the smallest positive rate the library accepts. */
const MIN_RATE_BPS = 1;

/** 10 000 bps (100 %) — covers the full basis-point scale. */
const MAX_RATE_BPS = 10_000;

/** One month — the shortest possible term. */
const MIN_TERM_MONTHS = 1;

/** 120 months (10 years) — well beyond the UI slider max, exercises long terms. */
const MAX_TERM_MONTHS = 120;

/**
 * Iteration count. Each iteration builds one schedule (up to 120 rows of
 * bigint arithmetic) and checks every invariant, so 1000 iterations stay well
 * under a second in CI while covering a meaningful slice of the input space.
 */
const FUZZ_ITERATIONS = 1000;

/** Fixed seed tied to the issue number for reproducibility. */
const FUZZ_SEED = 0x1026;

// ── Seeded PRNG ───────────────────────────────────────────────────────

/**
 * mulberry32 — a small, fast, deterministic PRNG producing a float in [0, 1).
 * Seeded so every CI run exercises identical inputs and any failure can be
 * reproduced without re-rolling.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform random integer in [min, max] inclusive. */
function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/**
 * Uniform random bigint in [min, max] inclusive. `max - min` stays below 2^53
 * for the bounds above, so the Number conversion is exact. The `Math.min`
 * clamp guards against a float product rounding up to `span` at the extreme.
 */
function randBigint(rng: () => number, min: bigint, max: bigint): bigint {
  const span = Number(max - min) + 1;
  const offset = Math.min(Math.floor(rng() * span), span - 1);
  return min + BigInt(offset);
}

// ── Input generation ──────────────────────────────────────────────────

interface FuzzInput {
  principal: bigint;
  interestRateBps: number;
  durationMonths: number;
}

/**
 * Generates one random valid input. Every fifth iteration uses a small
 * principal (<= 10 000 stroops) so the sub-cent regime — where floor-division
 * dust is largest relative to the principal — is exercised alongside the full
 * range.
 */
function generateInput(rng: () => number, index: number): FuzzInput {
  const smallPrincipal = index % 5 === 0;
  const principal = smallPrincipal
    ? randBigint(rng, MIN_PRINCIPAL_STROOPS, 10_000n)
    : randBigint(rng, MIN_PRINCIPAL_STROOPS, MAX_PRINCIPAL_STROOPS);

  const interestRateBps = randInt(rng, MIN_RATE_BPS, MAX_RATE_BPS);
  const durationMonths = randInt(rng, MIN_TERM_MONTHS, MAX_TERM_MONTHS);

  return { principal, interestRateBps, durationMonths };
}

// ── Invariant checks ─────────────────────────────────────────────────

/**
 * Asserts every invariant that must hold for a valid schedule. Throws with
 * the full failing input so it can be copied straight into the regression
 * section below.
 */
function assertInvariants(input: FuzzInput): void {
  const { principal, interestRateBps, durationMonths } = input;
  const { rows, summary } = buildAmortizationSchedule({
    principal,
    interestRateBps,
    durationMonths,
  });

  // A valid schedule always has at least one row: the generator guarantees
  // positive principal, rate and term.
  expect(rows.length).toBeGreaterThan(0);

  // Invariant 1 — payments sum to principal plus total interest.
  const paymentSum = rows.reduce((sum, row) => sum + row.payment, 0n);
  const principalSum = rows.reduce((sum, row) => sum + row.principal, 0n);
  const interestSum = rows.reduce((sum, row) => sum + row.interest, 0n);

  expect(paymentSum).toBe(principal + summary.totalInterest);
  expect(principalSum).toBe(principal);
  expect(interestSum).toBe(summary.totalInterest);

  // Per-row internal consistency: principal + interest === payment. Cheap to
  // check and catches a different class of bug than the column sums.
  for (const row of rows) {
    expect(row.principal + row.interest).toBe(row.payment);
  }

  // Invariant 2 — no negative balance on any row.
  for (const row of rows) {
    expect(row.remainingBalance).toBeGreaterThanOrEqual(0n);
    expect(row.remainingPrincipal).toBeGreaterThanOrEqual(0n);
    expect(row.payment).toBeGreaterThanOrEqual(0n);
    expect(row.principal).toBeGreaterThanOrEqual(0n);
    expect(row.interest).toBeGreaterThanOrEqual(0n);
  }

  // Monotonic decline — the balance never increases between consecutive rows.
  for (let i = 1; i < rows.length; i += 1) {
    expect(rows[i].remainingBalance).toBeLessThanOrEqual(rows[i - 1].remainingBalance);
  }

  // Invariant 3 — the final payment zeroes the balance exactly.
  const last = rows[rows.length - 1];
  expect(last.remainingBalance).toBe(0n);
  expect(last.remainingPrincipal).toBe(0n);
  expect(last.cumulativeInterest).toBe(summary.totalInterest);

  // Summary consistency — paid + remaining reconciles to the total owed.
  expect(summary.amountPaid + summary.amountRemaining).toBe(summary.totalRepayment);

  // Agreement with the standalone helpers.
  expect(summary.totalInterest).toBe(
    calculateTotalInterest(principal, interestRateBps)
  );
  expect(summary.monthlyPayment).toBe(
    calculateMonthlyPayment(principal, interestRateBps, durationMonths)
  );
}

/**
 * Formats a failing input as a TS object literal ready to paste into the
 * regression section.
 */
function formatInput(input: FuzzInput): string {
  return (
    `{ principal: ${input.principal}n, ` +
    `interestRateBps: ${input.interestRateBps}, ` +
    `durationMonths: ${input.durationMonths} }`
  );
}

// ── Fuzz test ─────────────────────────────────────────────────────────

describe("amortization schedule fuzz", () => {
  // Pre-generate from the fixed seed so the suite is deterministic and the
  // inputs are known even before assertions run.
  const rng = mulberry32(FUZZ_SEED);
  const inputs: FuzzInput[] = [];
  for (let i = 0; i < FUZZ_ITERATIONS; i += 1) {
    inputs.push(generateInput(rng, i));
  }

  it(`invariants hold for ${FUZZ_ITERATIONS} random valid combinations`, () => {
    const failures: string[] = [];

    inputs.forEach((input, i) => {
      try {
        assertInvariants(input);
      } catch (err) {
        failures.push(`iteration ${i}: ${formatInput(input)} — ${(err as Error).message}`);
      }
    });

    if (failures.length > 0) {
      // Cap the report so a systematic bug does not flood the console, but
      // surface enough to record each distinct failing input.
      const shown = failures.slice(0, 20);
      throw new Error(
        `${failures.length} invariant failure(s). ` +
          "Record each as a regression case in the section below.\n" +
          shown.join("\n") +
          (failures.length > shown.length ? `\n... and ${failures.length - shown.length} more` : "")
      );
    }
  });

  it("the fuzz inputs stay within the contract's enforced bounds", () => {
    // Guards the generator itself: every input must be a valid combination.
    for (const { principal, interestRateBps, durationMonths } of inputs) {
      expect(principal).toBeGreaterThanOrEqual(MIN_PRINCIPAL_STROOPS);
      expect(principal).toBeLessThanOrEqual(MAX_PRINCIPAL_STROOPS);
      expect(interestRateBps).toBeGreaterThanOrEqual(MIN_RATE_BPS);
      expect(interestRateBps).toBeLessThanOrEqual(MAX_RATE_BPS);
      expect(durationMonths).toBeGreaterThanOrEqual(MIN_TERM_MONTHS);
      expect(durationMonths).toBeLessThanOrEqual(MAX_TERM_MONTHS);
    }

    // Confirm the generator actually explored both the small and full
    // principal regimes (otherwise the % 5 branch is dead code).
    const small = inputs.filter((_, i) => i % 5 === 0);
    const large = inputs.filter((_, i) => i % 5 !== 0);
    expect(small.length).toBeGreaterThan(0);
    expect(large.length).toBeGreaterThan(0);
  });
});

// ── Fixed regression cases ───────────────────────────────────────────
//
// Any input that fails the fuzz above is recorded here as a named, permanent
// test so the bug can never be silently reintroduced. Each case is the exact
// combination that failed, lifted from the error output.
//
// The cases below were not produced by a failing run — they are deliberate
// boundary and oddly-shaped-term fixtures that the fuzz covers. They anchor
// the extreme corners of the input space so a future change that breaks only
// the edges is caught even before the fuzz runs.

interface RegressionCase extends FuzzInput {
  /** Human-readable label used as the test title. */
  title: string;
}

const REGRESSION_CASES: RegressionCase[] = [
  // Smallest expressible loan at the smallest positive rate and term.
  { title: "1 stroop at 1 bps over 1 month", principal: 1n, interestRateBps: 1, durationMonths: 1 },
  // One stroop spread across the longest term — maximises per-row dust.
  { title: "1 stroop at 1 bps over 120 months", principal: 1n, interestRateBps: 1, durationMonths: 120 },
  // A few stroops at a rate that does not divide the principal.
  { title: "3 stroops at 7 bps over 11 months", principal: 3n, interestRateBps: 7, durationMonths: 11 },
  // Prime terms that never divide evenly.
  { title: "prime term 7", principal: 10_000n * STROOPS_PER_UNIT + 3n, interestRateBps: 850, durationMonths: 7 },
  { title: "prime term 37", principal: 10_000n * STROOPS_PER_UNIT + 3n, interestRateBps: 850, durationMonths: 37 },
  { title: "prime term 97", principal: 10_000n * STROOPS_PER_UNIT + 3n, interestRateBps: 850, durationMonths: 97 },
  // Maximum rate (100 % APR).
  { title: "max rate", principal: 10_000n * STROOPS_PER_UNIT, interestRateBps: 10_000, durationMonths: 12 },
  // Maximum term.
  { title: "max term", principal: 10_000n * STROOPS_PER_UNIT, interestRateBps: 800, durationMonths: 120 },
  // Maximum principal.
  { title: "max principal", principal: MAX_PRINCIPAL_STROOPS, interestRateBps: 800, durationMonths: 12 },
  // All maxima together.
  { title: "all maxima", principal: MAX_PRINCIPAL_STROOPS, interestRateBps: 10_000, durationMonths: 120 },
  // The contract's originating term at a tier rate.
  { title: "origination term at fair tier", principal: 10_000n * STROOPS_PER_UNIT, interestRateBps: 800, durationMonths: 12 },
  // Two-month term — the shortest term that still splits the interest.
  { title: "2-month split", principal: 10_000n * STROOPS_PER_UNIT + 1n, interestRateBps: 850, durationMonths: 2 },
];

describe("amortization fuzz regression cases", () => {
  it.each(REGRESSION_CASES)("invariants hold: $title", (input) => {
    assertInvariants(input);
  });
});
