"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import type { TxUiPhase } from "../../lib/transaction-status";
import { phaseToStepIndex, TX_PROGRESS_STEPS } from "../../lib/transaction-status";

interface TransactionProgressProps {
  phase: TxUiPhase;
  isPolling: boolean;
}

export default function TransactionProgress({ phase, isPolling }: TransactionProgressProps) {
  const currentStep = phaseToStepIndex(phase);
  const isFailed = phase === "failed";
  const finalLabel = isFailed
    ? "Failed"
    : phase === "confirmed"
      ? "Confirmed"
      : TX_PROGRESS_STEPS[3];

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-6 mb-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Transaction Progress
        </h2>
        {isPolling && (
          <span className="inline-flex items-center gap-2 text-xs text-[var(--accent-primary-light)]">
            <span className="w-3 h-3 border-2 border-[var(--accent-primary)] border-t-transparent rounded-full animate-spin" />
            Monitoring on-chain…
          </span>
        )}
      </div>

      <div className="flex items-center w-full">
        {TX_PROGRESS_STEPS.map((label, index) => {
          const stepNumber = index + 1;
          const isCompleted = currentStep > stepNumber;
          const isActive = currentStep === stepNumber;
          const displayLabel =
            index === TX_PROGRESS_STEPS.length - 1 && (phase === "confirmed" || phase === "failed")
              ? finalLabel
              : label;

          return (
            <div key={label} className="contents">
              <div className="flex flex-col items-center min-w-[72px]">
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center transition-all duration-500
                    ${isCompleted ? "bg-[var(--accent-primary)] text-white scale-100" : ""}
                    ${isActive && !isFailed ? "border-2 border-[var(--accent-primary)] text-[var(--accent-primary)] animate-pulse-glow" : ""}
                    ${isActive && isFailed ? "border-2 border-[var(--error)] text-[var(--error)]" : ""}
                    ${!isCompleted && !isActive ? "border border-[var(--border-color)] text-[var(--text-muted)]" : ""}
                  `}
                >
                  {isCompleted ? (
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2.5}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  ) : (
                    <span className="font-bold text-sm">{stepNumber}</span>
                  )}
                </div>
                <p
                  className={`mt-2 text-[10px] sm:text-xs text-center max-w-[80px] leading-tight transition-colors duration-300 ${
                    isActive
                      ? isFailed
                        ? "text-[var(--error)] font-medium"
                        : "text-[var(--text-primary)] font-medium"
                      : isCompleted
                        ? "text-[var(--accent-primary-light)]"
                        : "text-[var(--text-muted)]"
                  }`}
                >
                  {displayLabel}
                </p>
              </div>
              {index < TX_PROGRESS_STEPS.length - 1 && (
                <div
                  className={`flex-1 h-1 mx-1 sm:mx-2 rounded-full transition-all duration-500 ${
                    currentStep > stepNumber
                      ? isFailed && currentStep === stepNumber + 1
                        ? "bg-[var(--error)]/60"
                        : "bg-[var(--accent-primary)]"
                      : "bg-[var(--border-color)]"
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
