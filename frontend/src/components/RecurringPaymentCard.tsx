"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState, useCallback } from "react";
import { Clock, Send, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { formatInterval, formatCountdown } from "@/lib/soroban";

export type ScheduleType = "fixed" | "linear_vesting";

export type RecurringSchedule = {
  id: string;
  name: string;
  type: ScheduleType;
  recipient: string;
  amountPerPeriod: string;
  intervalSecs: number;
  lastDisbursedAt: number;
  nextDisbursementAt: number;
  totalDisbursed: string;
  status: "active" | "paused" | "completed" | "cancelled";
  /** LinearVesting only */
  totalCap?: string;
  claimed?: string;
  claimable?: string;
};

type TxState = "idle" | "simulating" | "signing" | "pending" | "success" | "error";

function formatUSDC(raw: string | number): string {
  const n = typeof raw === "string" ? parseFloat(raw) : raw;
  if (isNaN(n)) return "0.00";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function shorten(addr: string) {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}\u2026${addr.slice(-4)}`;
}

function VestingProgressBar({
  claimed,
  claimable,
  totalCap,
}: {
  claimed: number;
  claimable: number;
  totalCap: number;
}) {
  if (totalCap <= 0) return null;

  const claimedPct = Math.min(100, (claimed / totalCap) * 100);
  const claimablePct = Math.min(100 - claimedPct, (claimable / totalCap) * 100);
  const unvestedPct = Math.max(0, 100 - claimedPct - claimablePct);

  return (
    <div className="space-y-2">
      <div className="flex justify-between text-xs">
        <span className="text-slate-400">Vesting Progress</span>
        <span className="text-slate-300 font-mono">
          {formatUSDC(claimed)} / {formatUSDC(totalCap)} USDC
        </span>
      </div>
      <div className="h-3 bg-slate-700/50 rounded-full overflow-hidden flex" role="progressbar" aria-valuenow={claimedPct + claimablePct} aria-valuemin={0} aria-valuemax={100} aria-label="Vesting progress">
        {claimedPct > 0 && (
          <div
            className="h-full bg-emerald-500 transition-all duration-500"
            style={{ width: `${claimedPct}%` }}
            title={`Claimed: ${formatUSDC(claimed)} USDC`}
          />
        )}
        {claimablePct > 0 && (
          <div
            className="h-full bg-cyan-400 transition-all duration-500"
            style={{ width: `${claimablePct}%` }}
            title={`Claimable: ${formatUSDC(claimable)} USDC`}
          />
        )}
        {unvestedPct > 0 && (
          <div
            className="h-full bg-slate-600 transition-all duration-500"
            style={{ width: `${unvestedPct}%` }}
            title={`Unvested: ${formatUSDC(totalCap - claimed - claimable)} USDC`}
          />
        )}
      </div>
      <div className="flex gap-4 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          <span className="text-slate-400">Claimed</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-cyan-400" />
          <span className="text-slate-400">Claimable</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-slate-600" />
          <span className="text-slate-400">Unvested</span>
        </span>
      </div>
    </div>
  );
}

function DisburseButton({
  schedule,
  txState,
  onDisburse,
}: {
  schedule: RecurringSchedule;
  txState: TxState;
  onDisburse: () => void;
}) {
  const nowSecs = Math.floor(Date.now() / 1000);
  const isDue = nowSecs >= schedule.nextDisbursementAt;
  const isPending = txState === "simulating" || txState === "signing" || txState === "pending";
  const isCompleted = txState === "success";
  const isError = txState === "error";

  const countdownText = formatCountdown(schedule.nextDisbursementAt, nowSecs);

  const buttonLabel = isPending
    ? "Processing\u2026"
    : isCompleted
      ? "Disbursed"
      : "Disburse now";

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onDisburse}
        disabled={!isDue || isPending || isCompleted || schedule.status !== "active"}
        className={`
          inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-200
          ${isDue && !isPending && !isCompleted && schedule.status === "active"
            ? "bg-cyan-500 hover:bg-cyan-400 text-slate-900 shadow-lg shadow-cyan-500/20"
            : "bg-slate-700/50 text-slate-400 cursor-not-allowed"
          }
        `}
        title={!isDue ? countdownText : undefined}
        aria-disabled={!isDue || isPending || isCompleted}
        aria-busy={isPending}
      >
        {isPending ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : isCompleted ? (
          <CheckCircle2 className="w-4 h-4" />
        ) : (
          <Send className="w-4 h-4" />
        )}
        {buttonLabel}
      </button>
      {!isDue && !isPending && !isCompleted && (
        <span className="flex items-center gap-1 text-xs text-slate-500">
          <Clock className="w-3 h-3" />
          {countdownText}
        </span>
      )}
    </div>
  );
}

export default function RecurringPaymentCard({
  schedule,
  onDisburse,
}: {
  schedule: RecurringSchedule;
  onDisburse?: (scheduleId: string) => Promise<void>;
}) {
  const [txState, setTxState] = useState<TxState>("idle");

  const handleDisburse = useCallback(async () => {
    if (!onDisburse) return;
    setTxState("simulating");
    try {
      await new Promise((r) => setTimeout(r, 300));
      setTxState("signing");
      await onDisburse(schedule.id);
      setTxState("pending");
      await new Promise((r) => setTimeout(r, 500));
      setTxState("success");
    } catch {
      setTxState("error");
      setTimeout(() => setTxState("idle"), 3000);
    }
  }, [onDisburse, schedule.id]);

  const isLinearVesting = schedule.type === "linear_vesting";
  const claimed = parseFloat(schedule.claimed || "0");
  const claimable = parseFloat(schedule.claimable || "0");
  const totalCap = parseFloat(schedule.totalCap || "0");

  const statusColors: Record<string, string> = {
    active: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    paused: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    completed: "bg-slate-500/10 text-slate-400 border-slate-500/20",
    cancelled: "bg-red-500/10 text-red-400 border-red-500/20",
  };

  return (
    <div className="p-6 bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)] space-y-4">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold text-white">{schedule.name}</h3>
          <p className="text-xs text-slate-400 font-mono">{shorten(schedule.recipient)}</p>
        </div>
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${statusColors[schedule.status]}`}>
          {schedule.status}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-slate-400 text-xs mb-1">Amount per period</p>
          <p className="text-white font-semibold font-mono">{formatUSDC(schedule.amountPerPeriod)} USDC</p>
        </div>
        <div>
          <p className="text-slate-400 text-xs mb-1">Cadence</p>
          <p className="text-white font-semibold">{formatInterval(schedule.intervalSecs)}</p>
        </div>
        <div>
          <p className="text-slate-400 text-xs mb-1">Total disbursed</p>
          <p className="text-white font-semibold font-mono">{formatUSDC(schedule.totalDisbursed)} USDC</p>
        </div>
        {isLinearVesting && (
          <div>
            <p className="text-slate-400 text-xs mb-1">Total cap</p>
            <p className="text-white font-semibold font-mono">{formatUSDC(schedule.totalCap || "0")} USDC</p>
          </div>
        )}
      </div>

      {isLinearVesting && totalCap > 0 && (
        <VestingProgressBar claimed={claimed} claimable={claimable} totalCap={totalCap} />
      )}

      {txState === "error" && (
        <div role="alert" className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          Disbursement failed. Please try again.
        </div>
      )}

      <div className="pt-2 border-t border-[var(--border-color)]">
        <DisburseButton schedule={schedule} txState={txState} onDisburse={handleDisburse} />
      </div>
    </div>
  );
}
