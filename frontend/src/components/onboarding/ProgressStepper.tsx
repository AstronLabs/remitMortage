"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";

export type StepState = "completed" | "current" | "upcoming";

interface ProgressStepperProps {
  steps: string[];
  /** 1-based step the applicant is on now. */
  currentStep: number;
  /**
   * 1-based furthest step the applicant has reached (issue #1114). Every step
   * before it has been completed, even when the applicant has gone back to an
   * earlier one. Defaults to `currentStep`.
   */
  furthestStep?: number;
  /** Called when the applicant picks a completed step to revisit. */
  onStepSelect?: (step: number) => void;
}

/** State of a 1-based step given where the applicant is and has been. */
export function getStepState(step: number, currentStep: number, furthestStep: number): StepState {
  if (step === currentStep) return "current";
  if (step < Math.max(currentStep, furthestStep)) return "completed";
  return "upcoming";
}

const STATE_DESCRIPTIONS: Record<StepState, string> = {
  completed: "completed",
  current: "current step",
  upcoming: "not yet reached",
};

function CheckIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-5 w-5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
    </svg>
  );
}

export default function ProgressStepper({
  steps,
  currentStep,
  furthestStep,
  onStepSelect,
}: ProgressStepperProps) {
  const total = steps.length;
  // A currentStep past the last step means every step is complete.
  const current = Math.max(currentStep, 1);
  const furthest = Math.max(furthestStep ?? current, current);
  const displayedStep = Math.min(current, total);
  const completedCount = steps.filter(
    (_, index) => getStepState(index + 1, current, furthest) === "completed"
  ).length;

  return (
    <nav
      aria-label="Application progress"
      data-testid="application-progress"
      className="sticky top-0 z-20 w-full rounded-xl bg-slate-900/95 py-2 backdrop-blur"
    >
      {/* Announced whenever the step changes so screen-reader users always know where they are. */}
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="application-progress-status"
        className="mb-3 text-xs font-semibold text-slate-300"
      >
        Step {displayedStep} of {total}: {steps[displayedStep - 1]}
        <span className="sr-only">. {completedCount} of {total} steps completed.</span>
      </p>

      <ol className="flex items-start">
        {steps.map((label, index) => {
          const stepNumber = index + 1;
          const state = getStepState(stepNumber, current, furthest);
          const isCompleted = state === "completed";
          const isActive = state === "current";
          const canRevisit = isCompleted && Boolean(onStepSelect);
          const accessibleName = `Step ${stepNumber} of ${total}: ${label}, ${STATE_DESCRIPTIONS[state]}`;

          const circle = (
            <span
              aria-hidden="true"
              className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-xs transition-all duration-300 shrink-0
                ${isCompleted ? "bg-cyan-400 text-slate-950 shadow-md shadow-cyan-500/25" : ""}
                ${isActive ? "border-2 border-cyan-400 text-cyan-400 bg-cyan-500/10 shadow-lg shadow-cyan-500/10" : ""}
                ${state === "upcoming" ? "border border-slate-800 text-slate-500 bg-slate-950/40" : ""}
              `}
            >
              {isCompleted ? <CheckIcon /> : stepNumber}
            </span>
          );
          const text = (
            <span
              aria-hidden="true"
              className={`mt-2 text-[10px] sm:text-xs font-semibold leading-tight text-center block
                ${isActive ? "text-cyan-400 font-bold" : isCompleted ? "text-slate-300" : "text-slate-400"}
              `}
            >
              {label}
            </span>
          );

          return (
            <li
              key={label}
              data-testid={`progress-step-${stepNumber}`}
              data-state={state}
              aria-current={isActive ? "step" : undefined}
              className="relative flex flex-1 flex-col items-center"
            >
              {index < total - 1 && (
                <span
                  aria-hidden="true"
                  className={`absolute top-[18px] left-1/2 h-[2px] w-full transition-all duration-500
                    ${stepNumber < Math.max(current, furthest) ? "bg-cyan-400" : "bg-slate-800"}
                  `}
                />
              )}
              {canRevisit ? (
                <button
                  type="button"
                  onClick={() => onStepSelect?.(stepNumber)}
                  aria-label={`${accessibleName}. Go back to this step`}
                  className="relative z-10 flex flex-col items-center rounded-lg px-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 hover:opacity-90"
                >
                  {circle}
                  {text}
                </button>
              ) : (
                <span className="relative z-10 flex flex-col items-center px-1">
                  <span className="sr-only">{accessibleName}</span>
                  {circle}
                  {text}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
