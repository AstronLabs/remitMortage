"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useMemo, useState } from "react";
import {
  buildAmortizationSchedule,
  formatRateBps,
  formatStroops,
  DEFAULT_DURATION_MONTHS,
  type PaymentStatus,
} from "@/lib/amortization";

/** Term slider bounds, in months. */
const MIN_TERM_MONTHS = 6;
const MAX_TERM_MONTHS = 36;

/** Rate slider bounds, in basis points (1% – 20% APR). */
const MIN_RATE_BPS = 100;
const MAX_RATE_BPS = 2_000;
const RATE_STEP_BPS = 25;

const STATUS_STYLES: Record<PaymentStatus, { dot: string; label: string }> = {
  paid: { dot: "bg-emerald-500", label: "Paid" },
  due: { dot: "bg-amber-500", label: "Next due" },
  upcoming: { dot: "bg-[var(--text-muted)]/40", label: "Upcoming" },
};

export interface AmortizationScheduleTableProps {
  /** Loan principal in stroops (7-decimal token units). */
  principal: bigint;
  /** Interest rate the LendingPool assigned to this loan, in basis points. */
  interestRateBps: number;
  /** Term from the on-chain repayment schedule. */
  durationMonths?: number;
  /** Installments already settled, from `RepaymentSchedule.payments_made`. */
  paymentsMade?: number;
  /** Token ticker shown alongside figures. */
  symbol?: string;
  /**
   * Lets the borrower model other terms and rates with the sliders. Disable to
   * pin the table to the loan's actual on-chain configuration.
   */
  interactive?: boolean;
}

/**
 * Month-by-month repayment table showing how each installment splits between
 * principal and interest.
 *
 * The figures come straight from `buildAmortizationSchedule`, which reproduces
 * the LendingPool's flat-interest schedule in integer stroops — so what the
 * borrower reads here is what the contract will charge.
 *
 * When `interactive`, the term and rate sliders re-derive the whole schedule on
 * every change. That is a pure `useMemo` over bigint arithmetic with no network
 * round-trip, so the splits update as the borrower drags.
 */
export default function AmortizationScheduleTable({
  principal,
  interestRateBps,
  durationMonths = DEFAULT_DURATION_MONTHS,
  paymentsMade = 0,
  symbol = "USDC",
  interactive = true,
}: AmortizationScheduleTableProps) {
  const [termMonths, setTermMonths] = useState(durationMonths);
  const [rateBps, setRateBps] = useState(interestRateBps);

  // Sliders only steer the projection; with `interactive` off the table stays
  // locked to the loan's real terms.
  const activeTerm = interactive ? termMonths : durationMonths;
  const activeRate = interactive ? rateBps : interestRateBps;

  const { rows, summary } = useMemo(
    () =>
      buildAmortizationSchedule({
        principal,
        interestRateBps: activeRate,
        durationMonths: activeTerm,
        paymentsMade,
      }),
    [principal, activeRate, activeTerm, paymentsMade]
  );

  const isProjection =
    interactive &&
    (activeTerm !== durationMonths || activeRate !== interestRateBps);

  const resetToLoanTerms = () => {
    setTermMonths(durationMonths);
    setRateBps(interestRateBps);
  };

  return (
    <div className="p-6 bg-[var(--bg-card)] rounded-md">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="text-lg font-semibold">Amortization Schedule</h3>
          <p className="text-sm text-[var(--text-muted)]">
            {formatStroops(principal)} {symbol} over {activeTerm} months at{" "}
            {formatRateBps(activeRate)} APR
          </p>
        </div>
        {isProjection && (
          <button
            type="button"
            onClick={resetToLoanTerms}
            className="text-xs underline text-[var(--text-muted)] hover:opacity-80"
          >
            Reset to loan terms
          </button>
        )}
      </div>

      {isProjection && (
        <p
          role="status"
          className="mb-4 text-xs px-3 py-2 rounded bg-amber-500/10 text-amber-600"
        >
          Projection only — your active loan runs {durationMonths} months at{" "}
          {formatRateBps(interestRateBps)}.
        </p>
      )}

      {interactive && (
        <div className="grid gap-4 sm:grid-cols-2 mb-6">
          <label className="text-sm">
            <span className="flex justify-between mb-1">
              <span>Repayment timeline</span>
              <strong>{termMonths} months</strong>
            </span>
            <input
              type="range"
              className="w-full"
              min={MIN_TERM_MONTHS}
              max={MAX_TERM_MONTHS}
              step={1}
              value={termMonths}
              onChange={(e) => setTermMonths(Number(e.target.value))}
              aria-label="Repayment timeline in months"
            />
          </label>

          <label className="text-sm">
            <span className="flex justify-between mb-1">
              <span>Interest rate</span>
              <strong>{formatRateBps(rateBps)}</strong>
            </span>
            <input
              type="range"
              className="w-full"
              min={MIN_RATE_BPS}
              max={MAX_RATE_BPS}
              step={RATE_STEP_BPS}
              value={rateBps}
              onChange={(e) => setRateBps(Number(e.target.value))}
              aria-label="Annual interest rate in basis points"
            />
          </label>
        </div>
      )}

      <dl className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-6 text-sm">
        <div>
          <dt className="text-[var(--text-muted)]">Monthly payment</dt>
          <dd className="font-semibold">
            {formatStroops(summary.monthlyPayment)} {symbol}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--text-muted)]">Total interest</dt>
          <dd className="font-semibold">
            {formatStroops(summary.totalInterest)} {symbol}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--text-muted)]">Total repayment</dt>
          <dd className="font-semibold">
            {formatStroops(summary.totalRepayment)} {symbol}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--text-muted)]">Remaining</dt>
          <dd className="font-semibold">
            {formatStroops(summary.amountRemaining)} {symbol}
          </dd>
        </div>
      </dl>

      {rows.length === 0 ? (
        <div className="text-sm text-[var(--text-muted)]">
          No schedule to display — this loan has no principal yet.
        </div>
      ) : (
        <div className="max-h-96 overflow-y-auto overflow-x-auto rounded border border-[var(--text-muted)]/15">
          <table className="w-full text-sm border-collapse">
            <caption className="sr-only">
              Monthly amortization schedule showing principal and interest
              splits for each installment
            </caption>
            <thead className="sticky top-0 bg-[var(--bg-card)] shadow-sm">
              <tr className="text-left text-[var(--text-muted)]">
                <th scope="col" className="px-3 py-2 font-medium">
                  #
                </th>
                <th scope="col" className="px-3 py-2 font-medium text-right">
                  Payment
                </th>
                <th scope="col" className="px-3 py-2 font-medium text-right">
                  Principal
                </th>
                <th scope="col" className="px-3 py-2 font-medium text-right">
                  Interest
                </th>
                <th scope="col" className="px-3 py-2 font-medium text-right">
                  Balance
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const style = STATUS_STYLES[row.status];
                return (
                  <tr
                    key={row.month}
                    data-status={row.status}
                    className={`border-t border-[var(--text-muted)]/10 ${
                      row.status === "paid" ? "opacity-60" : ""
                    } ${row.status === "due" ? "bg-amber-500/5" : ""}`}
                  >
                    <th scope="row" className="px-3 py-2 font-normal">
                      {row.month}
                    </th>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatStroops(row.payment)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatStroops(row.principal)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatStroops(row.interest)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatStroops(row.remainingBalance)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="inline-flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className={`inline-block w-2 h-2 rounded-full ${style.dot}`}
                        />
                        {style.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
