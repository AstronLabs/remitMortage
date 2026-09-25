"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { ShieldAlert, Clock, LogOut, CheckCircle2 } from "lucide-react";

interface IdleSessionModalProps {
  isOpen: boolean;
  remainingSeconds: number;
  totalWarningSeconds?: number;
  onExtendSession: () => void;
  onLogoutNow: () => void;
}

export default function IdleSessionModal({
  isOpen,
  remainingSeconds,
  totalWarningSeconds = 60,
  onExtendSession,
  onLogoutNow,
}: IdleSessionModalProps) {
  if (!isOpen) return null;

  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  const formattedTime = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

  const progressPercent = Math.min(100, Math.max(0, (remainingSeconds / totalWarningSeconds) * 100));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-fadeIn"
      role="dialog"
      aria-modal="true"
      aria-labelledby="idle-modal-title"
      data-testid="idle-warning-modal"
    >
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-amber-500/40 bg-gradient-to-b from-slate-900 via-slate-900 to-slate-950 p-6 md:p-8 shadow-2xl">
        {/* Glow backdrop effect */}
        <div className="absolute -top-12 -right-12 h-36 w-36 rounded-full bg-amber-500/10 blur-2xl pointer-events-none" />

        <div className="flex flex-col items-center text-center space-y-5">
          {/* Animated Icon Badge */}
          <div className="relative flex items-center justify-center w-16 h-16 rounded-2xl bg-amber-500/20 border border-amber-500/40 text-amber-400 shadow-inner">
            <ShieldAlert className="w-8 h-8 animate-pulse" />
          </div>

          <div className="space-y-2">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30 tracking-wide uppercase">
              <Clock className="w-3.5 h-3.5" /> Idle Session Security Warning
            </span>
            <h3 id="idle-modal-title" className="text-xl md:text-2xl font-extrabold text-white">
              Are you still there?
            </h3>
            <p className="text-sm text-slate-300 max-w-sm leading-relaxed">
              Your session will expire automatically to protect your financial data on this device.
            </p>
          </div>

          {/* Countdown Clock Display */}
          <div className="w-full bg-slate-950/60 rounded-xl p-4 border border-slate-800 space-y-2">
            <div className="text-xs text-slate-400 font-medium">Automatic Logout In</div>
            <div
              className="text-4xl font-extrabold font-mono text-amber-400 tracking-wider"
              data-testid="idle-countdown"
            >
              {formattedTime}
            </div>

            {/* Visual Progress Bar */}
            <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
              <div
                className="bg-gradient-to-r from-amber-500 to-amber-400 h-full transition-all duration-1000 ease-linear rounded-full"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-col sm:flex-row items-center gap-3 w-full pt-2">
            <button
              onClick={onExtendSession}
              data-testid="extend-session-btn"
              className="w-full sm:flex-1 py-3 px-4 rounded-xl bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 text-slate-950 font-bold text-sm shadow-lg shadow-amber-500/20 transition-all flex items-center justify-center gap-2 cursor-pointer"
            >
              <CheckCircle2 className="w-4 h-4" />
              Stay Logged In
            </button>
            <button
              onClick={onLogoutNow}
              data-testid="logout-now-btn"
              className="w-full sm:w-auto py-3 px-4 rounded-xl border border-slate-700 bg-slate-800/80 hover:bg-slate-800 text-slate-300 hover:text-white font-semibold text-sm transition-all flex items-center justify-center gap-2 cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              Log Out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
