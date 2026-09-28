// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Feature flag registry (issue #754).
 *
 * Single source of truth for rollout state. Each flag records its rollout
 * percentage, whether it still gates real variability (variants), and when
 * the rollout last changed — the audit in `services/featureFlagAudit.ts`
 * uses `lastChangedAt` to measure the "sustained period" (default 30 days).
 */

export interface FeatureFlagDefinition {
  /** Unique flag key, e.g. "new-repayment-schedule". */
  key: string;
  description: string;
  /** Owning team notified when this flag goes stale. */
  owner: string;
  /** Rollout percentage 0-100. */
  rolloutPercent: number;
  /** True when the flag still gates real variability (A/B, variants). */
  hasVariants: boolean;
  /** ISO timestamp of the last rollout/config change. */
  lastChangedAt: string;
}

export const STALE_FLAG_MIN_DAYS = 30;

export const FEATURE_FLAGS: FeatureFlagDefinition[] = [
  {
    key: "new-repayment-schedule",
    description: "Routes repayments through the new schedule calculator.",
    owner: "lending-team",
    rolloutPercent: 100,
    hasVariants: false,
    lastChangedAt: "2026-06-01T00:00:00.000Z",
  },
  {
    key: "legacy-kyc-fallback",
    description: "Keeps the legacy KYC provider path available.",
    owner: "onboarding-team",
    rolloutPercent: 0,
    hasVariants: false,
    lastChangedAt: "2026-06-15T00:00:00.000Z",
  },
  {
    key: "risk-based-pricing",
    description: "Partial rollout of risk-based pricing engine.",
    owner: "lending-team",
    rolloutPercent: 45,
    hasVariants: true,
    lastChangedAt: "2026-09-10T00:00:00.000Z",
  },
];
