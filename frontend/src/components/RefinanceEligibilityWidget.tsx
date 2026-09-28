"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import {
  checkRefinanceEligibility,
  type RefinanceLoanSnapshot,
} from "../lib/refinanceEligibility";

interface RefinanceEligibilityWidgetProps {
  loan: RefinanceLoanSnapshot;
  refinanceHref?: string;
}

/**
 * Borrower refinance eligibility checker widget (issue #753).
 *
 * Lightweight pre-check against data already on file — no full request
 * needed. Shows eligible / not-yet-eligible with the specific blocking
 * reason(s), and links into the full refinance flow when eligible.
 */
export default function RefinanceEligibilityWidget({
  loan,
  refinanceHref = "/repay?flow=refinance",
}: RefinanceEligibilityWidgetProps) {
  const result = checkRefinanceEligibility(loan);

  return (
    <div
      className="glass-card p-6"
      data-testid="refinance-eligibility-widget"
      role="region"
      aria-label="Refinance eligibility"
    >
      <h3 className="text-lg font-bold text-[var(--text-primary)]">
        Refinance Eligibility
      </h3>
      <p className="text-xs text-[var(--text-secondary)] mb-4">
        Checked against your current loan — no application needed.
      </p>

      {result.eligible ? (
        <div className="p-4 bg-emerald-950/30 border border-emerald-500/30 rounded-lg">
          <p
            className="text-sm font-semibold text-emerald-300"
            data-testid="refinance-eligible"
          >
            You&apos;re eligible to refinance — you could save{" "}
            {result.rateDeltaBps} bps on your rate.
          </p>
          <a
            href={refinanceHref}
            className="inline-block mt-3 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-500"
            data-testid="refinance-cta"
          >
            Start refinance request
          </a>
        </div>
      ) : (
        <div className="p-4 bg-amber-950/30 border border-amber-500/30 rounded-lg">
          <p
            className="text-sm font-semibold text-amber-200"
            data-testid="refinance-not-eligible"
          >
            Not yet eligible for refinancing
          </p>
          <ul className="mt-2 space-y-1 list-disc list-inside">
            {result.blockingReasons.map((reason) => (
              <li
                key={reason}
                className="text-xs text-amber-100/90"
                data-testid="refinance-blocking-reason"
              >
                {reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
