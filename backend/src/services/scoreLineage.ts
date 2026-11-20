// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { prisma } from "./db.js";
import { calculateCreditScore, type CreditScoreResult } from "./scoring.js";
import type { RemittanceAnalysis } from "./stellar.js";
import { loadConfig } from "../config.js";

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The scoring inputs that must be stored with a score for it to be reproducible. */
export type ScoreLineageInputs = RemittanceAnalysis;

export interface ScoreLineageRecord {
  inputs: ScoreLineageInputs;
  score: number;
  modelVersion: string;
  computedAt: Date;
  expiresAt: Date;
}

export interface BuildScoreLineageOptions {
  analysis: RemittanceAnalysis;
  score: number;
  modelVersion: string;
  /** Overrides `SCORE_LINEAGE_RETENTION_DAYS` when supplied. */
  retentionDays?: number;
  /** Timestamp the score was computed; defaults to now. */
  now?: Date;
}

/**
 * Copies exactly the fields `calculateCreditScore` depends on. Keeping this
 * explicit (rather than spreading `analysis`) stops unrelated fields being
 * persisted and makes accidental scoring-input drift visible in review.
 */
export function buildScoreLineageInputs(analysis: RemittanceAnalysis): ScoreLineageInputs {
  return {
    senderAddress: analysis.senderAddress,
    recipientAddress: analysis.recipientAddress,
    totalPayments: analysis.totalPayments,
    totalAmountUSDC: analysis.totalAmountUSDC,
    averageAmountUSDC: analysis.averageAmountUSDC,
    standardDeviation: analysis.standardDeviation,
    spanMonths: analysis.spanMonths,
    firstPayment: analysis.firstPayment,
    lastPayment: analysis.lastPayment,
    selfDealing: analysis.selfDealing,
    eligible: analysis.eligible,
    reason: analysis.reason,
  };
}

/**
 * Builds the lineage record written alongside a stored score. The expiry is
 * stamped at computation time from the configured retention window, so later
 * configuration changes do not retroactively extend a record's lifetime.
 */
export function buildScoreLineageRecord(options: BuildScoreLineageOptions): ScoreLineageRecord {
  const retentionDays = options.retentionDays ?? loadConfig().scoreLineageRetentionDays;
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error("score lineage retentionDays must be a non-negative number");
  }

  const computedAt = new Date(options.now ?? Date.now());
  const expiresAt = new Date(computedAt.getTime() + retentionDays * MS_PER_DAY);

  return {
    inputs: buildScoreLineageInputs(options.analysis),
    score: options.score,
    modelVersion: options.modelVersion,
    computedAt,
    expiresAt,
  };
}

/**
 * Recomputes a score from stored lineage inputs. Used by tests and available
 * to callers that need to prove a stored score is still reproducible.
 */
export function recomputeCreditScoreFromLineage(inputs: ScoreLineageInputs): CreditScoreResult {
  return calculateCreditScore(inputs);
}

/** Returns the lineage for a stored score (keyed by the verification result id). */
export async function getScoreLineage(scoreId: string) {
  return prisma.scoreLineage.findUnique({
    where: { verificationResultId: scoreId },
    include: {
      verificationResult: {
        select: {
          id: true,
          applicantId: true,
          analyzedAt: true,
          score: true,
          modelVersion: true,
          eligible: true,
        },
      },
      applicant: { select: { id: true, stellarAddress: true } },
    },
  });
}
