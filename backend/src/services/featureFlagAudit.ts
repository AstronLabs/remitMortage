// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Pure core of the stale feature-flag cleanup audit (issue #754).
 *
 * A flag is a cleanup candidate when it sits at a terminal rollout (100% on
 * with no variants, or 0% / killed) for a sustained period (default 30 days).
 * Anything mid-rollout or still gating variants is never flagged.
 *
 * This module never touches the codebase or deletes anything — the scheduled
 * job (`jobs/staleFeatureFlagAudit.ts`) cross-references candidates against
 * the code and only reports. Removal is a deliberate, reviewed step (see
 * `docs/STALE_FEATURE_FLAG_CLEANUP.md`).
 */

import type { FeatureFlagDefinition } from "../config/featureFlags.js";

export type StaleFlagKind = "rolled-out" | "killed";

export interface StaleFlagCandidate extends FeatureFlagDefinition {
  kind: StaleFlagKind;
  staleForDays: number;
  reason: string;
}

export interface FindStaleFlagsOptions {
  /** Days a terminal rollout must persist before it is stale. Default 30. */
  minStaleDays?: number;
  /** "Now" override for tests. */
  now?: Date;
}

export function daysBetween(fromIso: string, now: Date): number {
  const from = new Date(fromIso).getTime();
  if (!Number.isFinite(from)) return 0;
  return Math.floor((now.getTime() - from) / 86_400_000);
}

export function findStaleFlagCandidates(
  flags: FeatureFlagDefinition[],
  options: FindStaleFlagsOptions = {}
): StaleFlagCandidate[] {
  const minStaleDays = options.minStaleDays ?? 30;
  const now = options.now ?? new Date();
  const candidates: StaleFlagCandidate[] = [];

  for (const flag of flags) {
    const staleForDays = daysBetween(flag.lastChangedAt, now);
    if (staleForDays < minStaleDays) continue;

    if (flag.rolloutPercent === 100 && !flag.hasVariants) {
      candidates.push({
        ...flag,
        kind: "rolled-out",
        staleForDays,
        reason: `At 100% rollout with no variants for ${staleForDays}d (>= ${minStaleDays}d); fully rolled out, safe to inline and remove.`,
      });
    } else if (flag.rolloutPercent === 0 && !flag.hasVariants) {
      candidates.push({
        ...flag,
        kind: "killed",
        staleForDays,
        reason: `At 0% rollout for ${staleForDays}d (>= ${minStaleDays}d); fully killed, safe to remove dead branches.`,
      });
    }
  }

  return candidates;
}
