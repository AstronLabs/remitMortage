"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";

interface ProgressStepperProps {
  steps: string[];
  currentStep: number;
}

export default function ProgressStepper({ steps, currentStep }: ProgressStepperProps) {
  return (
    <div className="w-full">
      {/* ── Progress Track (Circles & Lines) ───────────────── */}
      <div className="flex items-center justify-between mb-3 relative">
        {steps.map((label, index) => {
          const stepNumber = index + 1;
          const isCompleted = currentStep > stepNumber;
          const isActive = currentStep === stepNumber;

          return (
            <React.Fragment key={label}>
              <div
                className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-xs transition-all duration-300 shrink-0 z-10
                  ${isCompleted ? "bg-cyan-400 text-slate-950 shadow-md shadow-cyan-500/25" : ""}
                  ${isActive ? "border-2 border-cyan-400 text-cyan-400 bg-cyan-500/10 shadow-lg shadow-cyan-500/10" : ""}
                  ${!isCompleted && !isActive ? "border border-slate-800 text-slate-500 bg-slate-950/40" : ""}
                `}
              >
                {isCompleted ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2.5}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                ) : (
                  <span>{stepNumber}</span>
                )}
              </div>
              {index < steps.length - 1 && (
                <div
                  className={`flex-1 h-[2px] mx-1 transition-all duration-500
                    ${currentStep > stepNumber ? "bg-cyan-400" : "bg-slate-800"}
                  `}
                />
              )}
            </React.Fragment>
          );
        })}
      </div>

      {/* ── Label Row ────────────────────────────────────────── */}
      <div className="grid grid-cols-4 gap-1">
        {steps.map((label, index) => {
          const stepNumber = index + 1;
          const isActive = currentStep === stepNumber;
          const isCompleted = currentStep > stepNumber;

          return (
            <div key={label} className="text-center">
              <span
                className={`text-[10px] sm:text-xs font-semibold leading-tight transition-colors duration-300 block
                  ${isActive ? "text-cyan-400 font-bold" : isCompleted ? "text-slate-300" : "text-slate-500"}
                `}
              >
                {label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
