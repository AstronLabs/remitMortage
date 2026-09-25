"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";

type LoanData = {
  status: string;
  principal: string;
  disbursed: string;
  repaid: string;
};

type EscrowData = {
  deposited: string;
  target: string;
  progress: number;
};

type LoanPrintSummaryProps = {
  loan: LoanData;
  escrow: EscrowData;
  borrowerAddress?: string;
};

export default function LoanPrintSummary({
  loan,
  escrow,
  borrowerAddress,
}: LoanPrintSummaryProps) {
  const principal = Number(loan.principal) || 0;
  const disbursed = Number(loan.disbursed) || 0;
  const repaid = Number(loan.repaid) || 0;
  const remaining = Math.max(0, principal - repaid);
  const deposited = Number(escrow.deposited) || 0;
  const target = Number(escrow.target) || 0;

  return (
    <div className="print-summary hidden print:block">
      <header className="print-header">
        <h1>RemitMortgage — Loan Summary</h1>
        <p className="print-date">
          Generated on {new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
        </p>
      </header>

      {borrowerAddress && (
        <section className="print-section">
          <h2>Borrower</h2>
          <table>
            <tbody>
              <tr>
                <td className="label">Wallet Address</td>
                <td className="value mono">{borrowerAddress}</td>
              </tr>
            </tbody>
          </table>
        </section>
      )}

      <section className="print-section">
        <h2>Loan Terms</h2>
        <table>
          <tbody>
            <tr>
              <td className="label">Status</td>
              <td className="value">{loan.status}</td>
            </tr>
            <tr>
              <td className="label">Principal</td>
              <td className="value">{principal.toLocaleString()} USDC</td>
            </tr>
            <tr>
              <td className="label">Disbursed</td>
              <td className="value">{disbursed.toLocaleString()} USDC</td>
            </tr>
            <tr>
              <td className="label">Repaid</td>
              <td className="value">{repaid.toLocaleString()} USDC</td>
            </tr>
            <tr>
              <td className="label">Remaining Balance</td>
              <td className="value">{remaining.toLocaleString()} USDC</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="print-section">
        <h2>Escrow (Down-Payment Savings)</h2>
        <table>
          <tbody>
            <tr>
              <td className="label">Deposited</td>
              <td className="value">{deposited.toLocaleString()} USDC</td>
            </tr>
            <tr>
              <td className="label">Target</td>
              <td className="value">{target.toLocaleString()} USDC</td>
            </tr>
            <tr>
              <td className="label">Progress</td>
              <td className="value">{escrow.progress}%</td>
            </tr>
          </tbody>
        </table>
      </section>

      <footer className="print-footer">
        <p>
          This document is for informational purposes only and does not constitute a binding agreement.
          Loan terms are subject to the on-chain lending pool contract.
        </p>
        <p>RemitMortgage Protocol — Built on Stellar</p>
      </footer>
    </div>
  );
}
