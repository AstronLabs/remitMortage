"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { progressPercent, type SavedApplicationProgress } from "@/lib/applicationProgressApi";

interface ApplicationResumeBannerProps {
  progress: SavedApplicationProgress;
  stepLabels: string[];
  onResume: () => void;
  onStartOver: () => void;
}

/** Offers to resume a server-saved application and shows how far along it is. */
export default function ApplicationResumeBanner({
  progress,
  stepLabels,
  onResume,
  onStartOver,
}: ApplicationResumeBannerProps) {
  const percent = progressPercent(progress.step, progress.totalSteps);
  const label = stepLabels[progress.step - 1];
  const savedAt = new Date(progress.updatedAt);

  return (
    <section
      data-testid="application-resume-banner"
      aria-labelledby="application-resume-heading"
      className="p-4 bg-cyan-500/10 border border-cyan-500/20 rounded-xl flex flex-col gap-3"
    >
      <div className="space-y-1">
        <p id="application-resume-heading" className="text-cyan-300 font-bold text-sm">
          Resume your application
        </p>
        <p className="text-slate-300 text-xs leading-relaxed">
          You reached step {progress.step} of {progress.totalSteps}
          {label ? ` (${label})` : ""}
          {Number.isNaN(savedAt.getTime()) ? "" : `, last saved ${savedAt.toLocaleString()}`}.
        </p>
      </div>
      <div
        role="progressbar"
        aria-label="Application progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden"
      >
        <div className="h-full bg-cyan-400" style={{ width: `${percent}%` }} />
      </div>
      <p className="text-xs text-slate-400">{percent}% complete</p>
      <div className="flex items-center gap-2.5">
        <button type="button" onClick={onResume} className="btn-cta text-xs !py-2 !px-4">
          Resume at step {progress.step}
        </button>
        <button type="button" onClick={onStartOver} className="btn-outline text-xs !py-2 !px-4">
          Start over
        </button>
      </div>
    </section>
  );
}
