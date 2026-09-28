"use client";

import React from "react";
import { Lock } from "lucide-react";

export type NotificationFrequency = "IMMEDIATE" | "DAILY_DIGEST" | "WEEKLY_DIGEST";

const FREQUENCY_OPTIONS: { value: NotificationFrequency; label: string }[] = [
  { value: "IMMEDIATE", label: "Immediate" },
  { value: "DAILY_DIGEST", label: "Daily Digest" },
  { value: "WEEKLY_DIGEST", label: "Weekly Digest" },
];

interface NotificationFrequencyControlProps {
  label: string;
  description: string;
  value: NotificationFrequency;
  onChange: (value: NotificationFrequency) => void;
  /**
   * When true, renders a fixed "Immediate" badge instead of the selector.
   * Used for security-critical categories that can never be delayed —
   * `lockedReason` explains why directly in the UI, not just via a tooltip.
   */
  locked?: boolean;
  lockedReason?: string;
}

/** One category's delivery-cadence row: Immediate / Daily Digest / Weekly Digest, or a locked "Immediate" badge. */
export default function NotificationFrequencyControl({
  label,
  description,
  value,
  onChange,
  locked = false,
  lockedReason,
}: NotificationFrequencyControlProps) {
  return (
    <div
      className={`rounded-xl border p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 ${
        locked ? "border-amber-500/30 bg-amber-500/5" : "border-slate-800 bg-slate-950/40"
      }`}
    >
      <div>
        <span className="text-sm font-bold text-white flex items-center gap-1.5">
          {label}
          {locked && <Lock aria-hidden="true" className="h-3.5 w-3.5 text-amber-400" />}
        </span>
        <p className="text-xs text-slate-400 mt-0.5 max-w-md leading-relaxed">{description}</p>
        {locked && lockedReason && (
          <p className="text-[11px] text-amber-400 mt-1.5 leading-relaxed">{lockedReason}</p>
        )}
      </div>

      {locked ? (
        <span
          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-800 text-slate-400 border border-slate-700 cursor-not-allowed whitespace-nowrap shrink-0"
          title={lockedReason}
          aria-disabled="true"
        >
          Immediate (locked)
        </span>
      ) : (
        <div className="flex gap-2 shrink-0" role="radiogroup" aria-label={`${label} frequency`}>
          {FREQUENCY_OPTIONS.map((opt) => {
            const active = value === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onChange(opt.value)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors whitespace-nowrap ${
                  active
                    ? "border-cyan-500 bg-cyan-500/10 text-white"
                    : "border-slate-700 text-slate-400 hover:border-slate-600"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
