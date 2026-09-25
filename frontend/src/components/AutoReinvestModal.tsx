"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";

interface AutoReinvestModalProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function AutoReinvestModal({ isOpen, onConfirm, onCancel }: AutoReinvestModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="auto-reinvest-title"
        className="relative w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-cyan-500/10 flex items-center justify-center text-cyan-400 text-base">
              &#x21BB;
            </div>
            <h2 id="auto-reinvest-title" className="text-lg font-bold text-white">
              Enable Auto-Reinvest
            </h2>
          </div>
          <button
            onClick={onCancel}
            aria-label="Close dialog"
            className="text-slate-400 hover:text-white transition-colors text-lg leading-none"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
          <p className="text-sm text-slate-300">
            When auto-reinvest is active,{" "}
            <strong className="text-white">
              any yield you earn is automatically rolled back into your tranche position
            </strong>{" "}
            rather than held as claimable cash.
          </p>

          <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 space-y-2">
            <p className="text-xs font-bold uppercase text-slate-400 tracking-wider">
              What this means
            </p>
            <ul className="text-sm text-slate-300 space-y-1.5">
              <li className="flex gap-2">
                <span className="text-cyan-400 mt-0.5 shrink-0">&#10003;</span>
                <span>Your yield compounds back into principal automatically</span>
              </li>
              <li className="flex gap-2">
                <span className="text-cyan-400 mt-0.5 shrink-0">&#10003;</span>
                <span>Higher effective APY over time from compounding</span>
              </li>
              <li className="flex gap-2">
                <span className="text-amber-400 mt-0.5 shrink-0">!</span>
                <span>
                  Yield is{" "}
                  <strong className="text-amber-300">not available to withdraw as cash</strong>{" "}
                  while this is on
                </span>
              </li>
            </ul>
          </div>

          <p className="text-xs text-slate-500">
            You can disable auto-reinvest at any time. Existing compounded yield becomes part of
            your deposited principal and cannot be separated.
          </p>
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-6 pt-0">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl border border-slate-700 text-slate-300 text-sm font-semibold hover:border-slate-600 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black text-sm font-bold transition-colors"
          >
            Enable Auto-Reinvest
          </button>
        </div>
      </div>
    </div>
  );
}
