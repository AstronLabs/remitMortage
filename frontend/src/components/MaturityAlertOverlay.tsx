"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState } from "react";
import Link from "next/link";
import { TrendingUp } from "lucide-react";

export type MilestoneAlert = {
  id: string;
  type: "ESCROW_REACHED" | "ESCROW_APPROACHING" | "PAYMENT_MISSED" | "MILESTONE_APPROVED";
  title: string;
  message: string;
  progress?: number;
  deposited?: string;
  target?: string;
  actionText?: string;
  actionHref?: string;
  onActionClick?: () => void;
};

export type CreditAlert = {
  type: "CREDIT_SCORE_DROP" | "CREDIT_RECOVERY_ON_TRACK" | "CREDIT_IMPROVEMENT_NEAR" | null;
  title: string;
  message: string;
};

interface MaturityAlertOverlayProps {
  escrow: { deposited: string; target: string; progress: number };
  loan?: { status: string; missedPayments?: number };
  milestoneAlert?: MilestoneAlert | null;
  creditAlert?: CreditAlert | null;
  creditScore?: number | null;
  onOpenDeposit?: () => void;
  onOpenRecovery?: () => void;
}

export default function MaturityAlertOverlay({
  escrow,
  loan,
  milestoneAlert,
  creditAlert,
  creditScore,
  onOpenDeposit,
  onOpenRecovery,
}: MaturityAlertOverlayProps) {
  const [dismissedAlerts, setDismissedAlerts] = useState<Record<string, boolean>>({});

  const depositedNum = Number(escrow.deposited) || 0;
  const targetNum = Number(escrow.target) || 0;
  const progress = escrow.progress || (targetNum > 0 ? (depositedNum / targetNum) * 100 : 0);
  const remaining = Math.max(0, targetNum - depositedNum);

  const isEscrowReached = progress >= 100;
  const isEscrowApproaching = progress >= 80 && progress < 100;
  const hasMissedPayment = (loan?.missedPayments ?? 0) > 0;

  function dismiss(id: string) {
    setDismissedAlerts((prev) => ({ ...prev, [id]: true }));
  }

  return (
    <div className="space-y-4 mb-8" role="region" aria-label="Escrow Maturity Alerts">
      {/* 1. Target Reached Alert Overlay (100% Escrow Progress) */}
      {isEscrowReached && !dismissedAlerts["escrow_reached"] && (
        <div className="relative overflow-hidden rounded-2xl border-2 border-emerald-500/50 bg-gradient-to-r from-emerald-950/90 via-slate-900 to-cyan-950/90 p-6 md:p-8 shadow-2xl backdrop-blur-xl">
          <div className="absolute -right-10 -bottom-10 w-48 h-48 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6 relative z-10">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="px-3 py-1 rounded-full text-xs font-extrabold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 uppercase tracking-wider flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                  Target Milestone Achieved
                </span>
                <span className="text-xs font-mono text-emerald-400/80">100% Complete</span>
              </div>
              <h2 className="text-2xl md:text-3xl font-extrabold text-white">
                🎉 Down-Payment Target Fully Reached!
              </h2>
              <p className="text-slate-300 text-sm max-w-2xl leading-relaxed">
                Congratulations! You have accumulated your full 30% down payment (
                <strong className="text-emerald-300 font-mono">${depositedNum.toLocaleString()} USDC</strong>).
                Your escrow savings are locked in Soroban smart contract and yield protocol. You are now eligible to initiate your 70% property loan request!
              </p>
            </div>

            <div className="flex flex-col sm:flex-row md:flex-col lg:flex-row items-stretch sm:items-center gap-3 shrink-0">
              <Link
                href="/repay"
                className="btn-cta bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 text-slate-950 font-bold !py-3.5 !px-6 shadow-lg shadow-emerald-500/20 text-center text-sm"
              >
                Request 70% Loan Disbursement &rarr;
              </Link>
              <button
                onClick={() => dismiss("escrow_reached")}
                className="px-4 py-3 text-xs font-semibold text-slate-400 hover:text-white transition-colors text-center"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2. Target Approaching Alert Overlay (80% to 99% Escrow Progress) */}
      {isEscrowApproaching && !dismissedAlerts["escrow_approaching"] && (
        <div className="relative overflow-hidden rounded-2xl border border-cyan-500/40 bg-gradient-to-r from-cyan-950/80 via-slate-900 to-slate-900 p-6 shadow-xl backdrop-blur-xl">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="px-3 py-0.5 rounded-full text-[11px] font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 uppercase tracking-wider">
                  ⚡ Down Payment Milestone
                </span>
                <span className="text-xs font-bold text-cyan-400 font-mono">{progress.toFixed(1)}% Goal</span>
              </div>
              <h3 className="text-xl font-bold text-white">Escrow Down-Payment Target Approaching!</h3>
              <p className="text-slate-300 text-xs md:text-sm max-w-xl">
                You have saved <strong className="text-cyan-300 font-mono">${depositedNum.toLocaleString()} USDC</strong> toward your target of ${targetNum.toLocaleString()} USDC. You are only{" "}
                <strong className="text-emerald-300 font-mono">${remaining.toLocaleString()} USDC</strong> away from unlocking property loan financing!
              </p>
            </div>

            <div className="flex items-center gap-3">
              {onOpenDeposit && (
                <button
                  onClick={onOpenDeposit}
                  className="btn-cta text-xs !py-3 !px-5 shadow-cyan-500/20"
                >
                  Deposit ${remaining.toLocaleString()} USDC
                </button>
              )}
              <button
                onClick={() => dismiss("escrow_approaching")}
                className="text-xs text-slate-400 hover:text-white px-3 py-2"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3. Missed Payment Warning Alert Overlay */}
      {hasMissedPayment && !dismissedAlerts["missed_payment"] && (
        <div className="rounded-2xl border border-amber-500/50 bg-amber-950/40 p-5 shadow-lg backdrop-blur-xl flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center shrink-0 text-amber-400 text-xl font-bold">
              ⚠️
            </div>
            <div>
              <h4 className="text-base font-bold text-amber-200">Action Required: Scheduled Payment Missed</h4>
              <p className="text-xs text-amber-300/80 mt-1 max-w-xl">
                You have {loan?.missedPayments} missed payment on your schedule. Complete your installment to keep your borrower credit score intact and maintain mortgage eligibility.
              </p>
              {(creditScore != null) && (
                <p className="text-xs text-amber-400/70 mt-2">
                  Score impact: {creditScore}/100 · On-time payments rebuild +4 pts each
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <Link href="/repay" className="btn-primary bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold !py-2.5 !px-4">
              Make Payment Now
            </Link>
            <button
              onClick={() => dismiss("missed_payment")}
              className="text-xs text-slate-400 hover:text-white"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* 5. Credit Score Alert (pre-populated based on active loan conditions) */}
      {creditAlert && !dismissedAlerts[`credit_${creditAlert.type}`] && (
        <div
          className={`rounded-2xl border p-5 shadow-lg backdrop-blur-xl flex flex-col md:flex-row md:items-center md:justify-between gap-4 ${
            creditAlert.type === "CREDIT_SCORE_DROP"
              ? "border-amber-500/40 bg-amber-950/30"
              : creditAlert.type === "CREDIT_IMPROVEMENT_NEAR"
                ? "border-emerald-500/30 bg-emerald-950/30"
                : "border-cyan-500/30 bg-cyan-950/30"
          }`}
        >
          <div className="flex items-start gap-3">
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 text-xl font-bold ${
                creditAlert.type === "CREDIT_SCORE_DROP"
                  ? "bg-amber-500/20 border border-amber-500/40 text-amber-400"
                  : creditAlert.type === "CREDIT_IMPROVEMENT_NEAR"
                    ? "bg-emerald-500/20 border border-emerald-500/40 text-emerald-400"
                    : "bg-cyan-500/20 border border-cyan-500/40 text-cyan-400"
              }`}
            >
              <TrendingUp className="w-5 h-5" />
            </div>
            <div>
              <h4
                className={`text-base font-bold ${
                  creditAlert.type === "CREDIT_SCORE_DROP"
                    ? "text-amber-200"
                    : creditAlert.type === "CREDIT_IMPROVEMENT_NEAR"
                      ? "text-emerald-200"
                      : "text-cyan-200"
                }`}
              >
                {creditAlert.title}
              </h4>
              <p className="text-xs text-slate-300/80 mt-1 max-w-xl">
                {creditAlert.message}
              </p>
              {(creditScore != null) && (
                <p className="text-[11px] text-slate-400 mt-2">
                  Current credit score: <span className="font-bold text-white">{creditScore}/100</span>
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {onOpenRecovery && (
              <button
                onClick={() => {
                  onOpenRecovery();
                  dismiss(`credit_${creditAlert.type}`);
                }}
                className={`text-xs font-bold !py-2.5 !px-4 rounded-lg transition-colors ${
                  creditAlert.type === "CREDIT_SCORE_DROP"
                    ? "bg-amber-500 hover:bg-amber-400 text-slate-950"
                    : creditAlert.type === "CREDIT_IMPROVEMENT_NEAR"
                      ? "bg-emerald-600 hover:bg-emerald-500 text-white"
                      : "bg-cyan-600 hover:bg-cyan-500 text-white"
                }`}
              >
                View Recovery Plan
              </button>
            )}
            <button
              onClick={() => dismiss(`credit_${creditAlert.type}`)}
              className="text-xs text-slate-400 hover:text-white"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* 4. Custom Milestone Event Alert (e.g. Multisig Approval) */}
      {milestoneAlert && !dismissedAlerts[milestoneAlert.id] && (
        <div className="rounded-2xl border border-indigo-500/40 bg-indigo-950/40 p-5 shadow-lg backdrop-blur-xl flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center shrink-0 text-indigo-300 text-xl font-bold">
              🏗️
            </div>
            <div>
              <h4 className="text-base font-bold text-indigo-200">{milestoneAlert.title}</h4>
              <p className="text-xs text-indigo-300/80 mt-1 max-w-xl">{milestoneAlert.message}</p>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {milestoneAlert.actionHref ? (
              <Link href={milestoneAlert.actionHref} className="btn-outline-blue text-xs !py-2.5 !px-4">
                {milestoneAlert.actionText || "View Details"}
              </Link>
            ) : (
              milestoneAlert.onActionClick && (
                <button onClick={milestoneAlert.onActionClick} className="btn-outline-blue text-xs !py-2.5 !px-4">
                  {milestoneAlert.actionText || "View Details"}
                </button>
              )
            )}
            <button onClick={() => dismiss(milestoneAlert.id)} className="text-xs text-slate-400 hover:text-white">
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
