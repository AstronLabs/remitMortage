// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";

export type Stage = "Pending" | "Proposed" | "Approved" | "Disbursed";

const STAGES: Stage[] = ["Pending", "Proposed", "Approved", "Disbursed"];

interface MilestoneTrackerProps {
  currentStage: Stage;
}

export default function MilestoneTracker({ currentStage }: MilestoneTrackerProps) {
  const currentIndex = STAGES.indexOf(currentStage);

  return (
    <div className="w-full py-4">
      <div className="flex items-center justify-between relative">
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-full h-1 bg-[var(--bg-primary)] rounded-full -z-10" />

        {STAGES.map((stage, index) => {
          const isCompleted = index < currentIndex;
          const isCurrent = index === currentIndex;

          return (
            <div key={stage} className="flex flex-col items-center relative z-10">
              <div
                className={`w-6 h-6 md:w-8 md:h-8 rounded-full flex items-center justify-center text-xs md:text-sm font-bold transition-colors
                  ${
                    isCompleted
                      ? "bg-[var(--success)] text-white shadow-[var(--shadow-glow)]"
                      : isCurrent
                        ? "bg-[var(--accent-primary)] text-white ring-4 ring-[var(--accent-primary)]/20 shadow-[var(--shadow-glow)]"
                        : "bg-[var(--bg-card)] border-2 border-[var(--border-color)] text-[var(--text-muted)]"
                  }
                `}
              >
                {isCompleted ? (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="w-3 h-3 md:w-4 md:h-4"
                  >
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                ) : (
                  index + 1
                )}
              </div>
              <span
                className={`mt-2 text-[10px] md:text-xs font-semibold ${isCurrent ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}`}
              >
                {stage}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
