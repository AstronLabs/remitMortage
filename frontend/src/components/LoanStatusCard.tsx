"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";

type Loan = {
  status: string;
  principal: string;
  disbursed: string;
  repaid: string;
};

export default function LoanStatusCard({ loan }: { loan: Loan }) {
  const principal = Number(loan.principal) || 0;
  const disbursed = Number(loan.disbursed) || 0;
  const repaid = Number(loan.repaid) || 0;
  const remaining = Math.max(0, principal - disbursed);

  return (
    <div className="p-6 bg-[var(--bg-card)] rounded-md">
      <h3 className="text-lg font-semibold mb-4">Loan Status</h3>

      {principal === 0 ? (
        <div className="text-sm text-[var(--text-muted)]">No active loan</div>
      ) : (
        <div className="space-y-2 text-sm">
          <div>
            Principal: <strong>{principal.toLocaleString()} USDC</strong>
          </div>
          <div>
            Disbursed: <strong>{disbursed.toLocaleString()} USDC</strong>
          </div>
          <div>
            Repaid: <strong>{repaid.toLocaleString()} USDC</strong>
          </div>
          <div>
            Remaining (principal - disbursed): <strong>{remaining.toLocaleString()} USDC</strong>
          </div>
          <div>
            Status: <strong>{loan.status}</strong>
          </div>
        </div>
      )}
    </div>
  );
}
