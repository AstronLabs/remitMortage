"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { useTextSizeStore } from "@/app/stores/useTextSizeStore";
import { TEXT_SIZE_STEPS } from "@/app/lib/textSize";

/**
 * Text-size control. A small set of steps applied through the root-level scale
 * (`data-text-size` on `<html>`), so the whole UI scales from one switch rather
 * than per-component overrides.
 */
export default function TextSizeSettings() {
  const { textSize, setTextSize } = useTextSizeStore();

  return (
    <div className="space-y-3" data-testid="text-size-settings">
      <h3 className="text-xs font-bold uppercase tracking-wider text-cyan-400">Text Size</h3>
      <p className="text-xs text-slate-400">
        Scale text and spacing across the whole app. Pick the largest size that
        stays comfortable for you.
      </p>

      <div role="radiogroup" aria-label="Text size" className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {TEXT_SIZE_STEPS.map((step) => {
          const selected = textSize === step.id;
          return (
            <button
              key={step.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setTextSize(step.id)}
              className={`rounded-xl border p-4 text-left transition-all ${
                selected
                  ? "border-cyan-500 bg-cyan-500/10"
                  : "border-slate-800 bg-slate-950/40 text-slate-400 hover:border-slate-700"
              }`}
            >
              <span
                className="block font-bold text-white"
                style={{ fontSize: `${step.percent / 100}rem` }}
                aria-hidden="true"
              >
                Aa
              </span>
              <span className="mt-1 block text-sm font-semibold text-white">{step.label}</span>
              <span className="block text-xs text-slate-400 mt-0.5">{step.percent}%</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
