// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Interest rate sheet version history (issue #746).
 *
 * A rate sheet prices new loan offers. Every change is appended as a new
 * InterestRateSheetVersion (a database trigger rejects UPDATE/DELETE), with
 * its effective time, the field-level diff against the previous version and
 * the admin who published it. A loan application stores the id of the version
 * that priced it, so any historical offer can be traced to the exact sheet in
 * effect when it was generated.
 */

import {
  prisma,
  LOAN_INTEREST_RATE_MIN_BPS,
  LOAN_INTEREST_RATE_MAX_BPS,
  LOAN_INTEREST_RATE_DEFAULT_BPS,
} from "./db.js";
import { logAudit } from "./audit.js";
import logger from "../utils/logger.js";

export interface CreditScoreTier {
  /** Applicants scoring at least this much get `rateBps` (highest matching tier wins). */
  minCreditScore: number;
  rateBps: number;
}

export interface RateSheetRates {
  /** Rate for applicants with no credit score or below every tier. */
  baseRateBps: number;
  creditScoreTiers?: CreditScoreTier[];
}

export interface RateSheetChange {
  /** "baseRateBps" or "creditScoreTiers[>=700]". */
  path: string;
  before: number | null;
  after: number | null;
}

export class RateSheetError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400
  ) {
    super(message);
  }
}

const MAX_CREDIT_SCORE = 1000;
/** Tolerated clock skew when an admin submits an explicit effective time. */
const EFFECTIVE_AT_SKEW_MS = 5_000;
const PUBLISH_RETRIES = 3;

function validateRateBps(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < LOAN_INTEREST_RATE_MIN_BPS ||
    value > LOAN_INTEREST_RATE_MAX_BPS
  ) {
    throw new RateSheetError(
      "invalid_rate",
      `${field} must be an integer between ${LOAN_INTEREST_RATE_MIN_BPS} and ${LOAN_INTEREST_RATE_MAX_BPS} basis points`
    );
  }
  return value;
}

/**
 * Validates untrusted input and returns it in canonical form (tiers sorted by
 * minCreditScore), so two equal sheets always compare and diff as equal.
 */
export function validateRates(input: unknown): RateSheetRates {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RateSheetError("invalid_rates", "rates must be an object");
  }
  const raw = input as Record<string, unknown>;
  const rates: RateSheetRates = { baseRateBps: validateRateBps(raw.baseRateBps, "baseRateBps") };

  if (raw.creditScoreTiers !== undefined) {
    if (!Array.isArray(raw.creditScoreTiers)) {
      throw new RateSheetError("invalid_rates", "creditScoreTiers must be an array");
    }
    const seen = new Set<number>();
    const tiers = raw.creditScoreTiers.map((t, i) => {
      const tier = (t ?? {}) as Record<string, unknown>;
      const min = tier.minCreditScore;
      if (typeof min !== "number" || !Number.isInteger(min) || min < 0 || min > MAX_CREDIT_SCORE) {
        throw new RateSheetError(
          "invalid_rates",
          `creditScoreTiers[${i}].minCreditScore must be an integer between 0 and ${MAX_CREDIT_SCORE}`
        );
      }
      if (seen.has(min)) {
        throw new RateSheetError("invalid_rates", `Duplicate tier for minCreditScore ${min}`);
      }
      seen.add(min);
      return { minCreditScore: min, rateBps: validateRateBps(tier.rateBps, `creditScoreTiers[${i}].rateBps`) };
    });
    if (tiers.length > 0) {
      rates.creditScoreTiers = tiers.sort((a, b) => a.minCreditScore - b.minCreditScore);
    }
  }
  return rates;
}

/** Field-level diff between two canonical rate sheets. `from` null means "no prior version". */
export function diffRates(from: RateSheetRates | null, to: RateSheetRates): RateSheetChange[] {
  const changes: RateSheetChange[] = [];
  if (from?.baseRateBps !== to.baseRateBps) {
    changes.push({ path: "baseRateBps", before: from?.baseRateBps ?? null, after: to.baseRateBps });
  }

  const before = new Map((from?.creditScoreTiers ?? []).map((t) => [t.minCreditScore, t.rateBps]));
  const after = new Map((to.creditScoreTiers ?? []).map((t) => [t.minCreditScore, t.rateBps]));
  const mins = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b);
  for (const min of mins) {
    const b = before.get(min) ?? null;
    const a = after.get(min) ?? null;
    if (b !== a) changes.push({ path: `creditScoreTiers[>=${min}]`, before: b, after: a });
  }
  return changes;
}

/** Prices an offer from a rate sheet: highest tier at or below the score, else the base rate. */
export function priceOffer(rates: RateSheetRates, creditScore: number | null | undefined): number {
  if (typeof creditScore === "number") {
    const tier = [...(rates.creditScoreTiers ?? [])]
      .sort((a, b) => b.minCreditScore - a.minCreditScore)
      .find((t) => creditScore >= t.minCreditScore);
    if (tier) return tier.rateBps;
  }
  return rates.baseRateBps;
}

export interface PublishRateSheetInput {
  rates: unknown;
  changedBy: string;
  changeReason?: unknown;
  /** Defaults to now. Must not be in the past: that would rewrite history. */
  effectiveAt?: unknown;
  ipAddress?: string;
}

/** Appends a new rate sheet version. Never modifies an existing one. */
export async function publishRateSheet(input: PublishRateSheetInput) {
  const rates = validateRates(input.rates);

  let changeReason: string | null = null;
  if (input.changeReason !== undefined && input.changeReason !== null) {
    if (typeof input.changeReason !== "string" || input.changeReason.trim().length === 0) {
      throw new RateSheetError("invalid_field", "changeReason must be a non-empty string when provided");
    }
    changeReason = input.changeReason.trim();
  }

  const now = new Date();
  let effectiveAt = now;
  if (input.effectiveAt !== undefined && input.effectiveAt !== null) {
    effectiveAt = new Date(String(input.effectiveAt));
    if (Number.isNaN(effectiveAt.getTime())) {
      throw new RateSheetError("invalid_field", "effectiveAt must be a valid date");
    }
    if (effectiveAt.getTime() < now.getTime() - EFFECTIVE_AT_SKEW_MS) {
      throw new RateSheetError(
        "invalid_field",
        "effectiveAt cannot be in the past; a backdated sheet would rewrite which rates were in effect"
      );
    }
  }

  for (let attempt = 1; ; attempt++) {
    const latest = await prisma.interestRateSheetVersion.findFirst({ orderBy: { version: "desc" } });
    const changedValues = diffRates((latest?.rates as RateSheetRates | undefined) ?? null, rates);
    if (latest && changedValues.length === 0) {
      throw new RateSheetError(
        "no_changes",
        `Rates are identical to version ${latest.version}; nothing to publish`,
        409
      );
    }

    try {
      const created = await prisma.interestRateSheetVersion.create({
        data: {
          version: (latest?.version ?? 0) + 1,
          effectiveAt,
          rates: rates as any,
          changedValues: changedValues as any,
          changedBy: input.changedBy,
          changeReason,
        },
      });

      await logAudit({
        action: "RATE_SHEET_PUBLISHED",
        actorAddress: input.changedBy,
        ipAddress: input.ipAddress,
        metadata: {
          version: created.version,
          rateSheetVersionId: created.id,
          effectiveAt: created.effectiveAt,
          changedValues,
          changeReason,
        },
      });
      return created;
    } catch (err: any) {
      // A concurrent publish claimed this version number: recompute the diff
      // against the new latest version and try again.
      if (err?.code === "P2002" && attempt < PUBLISH_RETRIES) continue;
      if (err?.code === "P2002") {
        throw new RateSheetError("version_conflict", "Concurrent rate sheet updates; retry", 409);
      }
      throw err;
    }
  }
}

/** The version in effect at `at`: the latest one whose effective time has arrived. */
export async function resolveRateSheetAt(at: Date) {
  return prisma.interestRateSheetVersion.findFirst({
    where: { effectiveAt: { lte: at } },
    orderBy: [{ effectiveAt: "desc" }, { version: "desc" }],
  });
}

export interface OfferPricing {
  interestRateBps: number;
  rateSheetVersionId: string;
}

/**
 * Prices a new offer from the sheet in effect at `at`. The returned version id
 * is what gets stored on the offer record. Returns null only when no version
 * exists yet, in which case the caller falls back to the legacy default rate.
 */
export async function priceNewOffer(
  creditScore: number | null | undefined,
  at: Date = new Date()
): Promise<OfferPricing | null> {
  const sheet = await resolveRateSheetAt(at);
  if (!sheet) {
    logger.error("No interest rate sheet in effect; pricing offer at the default rate without a version reference", {
      at,
      defaultBps: LOAN_INTEREST_RATE_DEFAULT_BPS,
    });
    return null;
  }
  return {
    interestRateBps: priceOffer(sheet.rates as RateSheetRates, creditScore),
    rateSheetVersionId: sheet.id,
  };
}

export async function listRateSheetVersions(limit = 50, beforeVersion?: number) {
  return prisma.interestRateSheetVersion.findMany({
    where: beforeVersion !== undefined ? { version: { lt: beforeVersion } } : undefined,
    orderBy: { version: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
  });
}

export async function getRateSheetVersion(version: number) {
  return prisma.interestRateSheetVersion.findUnique({ where: { version } });
}

/**
 * Diff between two stored versions, computed from their full rate sheets
 * rather than the stored per-version diff so any pair can be compared.
 */
export async function diffRateSheetVersions(fromVersion: number, toVersion: number) {
  const [from, to] = await Promise.all([getRateSheetVersion(fromVersion), getRateSheetVersion(toVersion)]);
  if (!from || !to) {
    throw new RateSheetError(
      "not_found",
      `Rate sheet version ${!from ? fromVersion : toVersion} not found`,
      404
    );
  }
  return {
    from,
    to,
    changes: diffRates(from.rates as RateSheetRates, to.rates as RateSheetRates),
  };
}

/** Traces a loan offer to the rate sheet version that priced it. Null when the loan does not exist. */
export async function getRateSheetForLoan(loanId: string) {
  const loan = await prisma.loanApplication.findFirst({
    where: { id: loanId, deletedAt: null },
    select: {
      id: true,
      createdAt: true,
      interestRateBps: true,
      rateSheetVersionId: true,
      rateSheetVersion: true,
    },
  });
  if (!loan) return null;
  return {
    loanId: loan.id,
    offerGeneratedAt: loan.createdAt,
    interestRateBps: loan.interestRateBps,
    rateSheetVersionId: loan.rateSheetVersionId,
    // Null for loans created before rate sheets were versioned.
    rateSheetVersion: loan.rateSheetVersion,
  };
}
