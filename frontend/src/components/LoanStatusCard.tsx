"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { speakAmount, speakRateBps, speakTermMonths } from "@/lib/loanTermsNarration";

type Loan = {
  status: string;
  principal: string;
  disbursed: string;
  repaid: string;
  /**
   * Optional terms used to build the spoken narration. Absent on callers that
   * only track balances, in which case those terms are simply not narrated.
   */
  interestRateBps?: number;
  termMonths?: number;
  /** Late-payment penalty, e.g. a fee basis-point figure or a flat amount. */
  lateFeeBps?: number;
};

export default function LoanStatusCard({ loan }: { loan: Loan }) {
  const principal = Number(loan.principal) || 0;
  const disbursed = Number(loan.disbursed) || 0;
  const repaid = Number(loan.repaid) || 0;
  const remaining = Math.max(0, principal - disbursed);

  return (
    <div data-testid="loan-status-card" className="p-6 bg-[var(--bg-card)] rounded-md">
      <h3 className="text-lg font-semibold mb-4">Loan Status</h3>

      {principal === 0 ? (
        <div className="text-sm text-[var(--text-muted)]">No active loan</div>
      ) : (
        <div className="space-y-2 text-sm">
          {/*
            Each term carries a `data-narration` summary written for the ear
            rather than the eye. The spoken order is DOM order, which is the
            order a sighted user reads: what the loan is, what it costs, how
            long it lasts, what happens if a payment is late, then progress.
          */}
          <div data-narration={`Principal, ${speakAmount(principal)}`}>
            Principal: <strong>{principal.toLocaleString()} USDC</strong>
          </div>

          {typeof loan.interestRateBps === "number" && (
            <div data-narration={`Interest rate, ${speakRateBps(loan.interestRateBps)} per year`}>
              Interest rate: <strong>{(loan.interestRateBps / 100).toFixed(2)}%</strong>
            </div>
          )}

          {typeof loan.termMonths === "number" && (
            <div data-narration={`Term length, ${speakTermMonths(loan.termMonths)}`}>
              Term length: <strong>{loan.termMonths} months</strong>
            </div>
          )}

          {typeof loan.lateFeeBps === "number" && (
            <div
              data-narration={`Late payment penalty, ${speakRateBps(loan.lateFeeBps)} of the overdue amount`}
            >
              Late penalty: <strong>{(loan.lateFeeBps / 100).toFixed(2)}%</strong>
            </div>
          )}

          <div data-narration={`Disbursed so far, ${speakAmount(disbursed)}`}>
            Disbursed: <strong>{disbursed.toLocaleString()} USDC</strong>
          </div>

          <div data-narration={`Repaid so far, ${speakAmount(repaid)}`}>
            Repaid: <strong>{repaid.toLocaleString()} USDC</strong>
          </div>

          <div data-narration={`Remaining to disburse, ${speakAmount(remaining)}`}>
            Remaining (principal - disbursed): <strong>{remaining.toLocaleString()} USDC</strong>
          </div>

          <div data-narration={`Current status, ${loan.status}`}>
            Status: <strong>{loan.status}</strong>
          </div>
        </div>
      )}
    </div>
  );
}
