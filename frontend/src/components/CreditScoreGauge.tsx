"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { CreditTier, TIER_CONFIG } from "@/lib/creditRecovery";

interface CreditScoreGaugeProps {
  currentScore: number;
  currentTier: CreditTier;
  targetScore: number;
  targetTier: CreditTier;
}

export function CreditScoreGauge({
  currentScore,
  currentTier,
  targetScore,
  targetTier,
}: CreditScoreGaugeProps) {
  const currentColor = TIER_CONFIG[currentTier].color;
  const targetColor = TIER_CONFIG[targetTier].color;

  const tierBoundaries = [
    { label: "0", value: 0 },
    { label: "40", value: 40 },
    { label: "60", value: 60 },
    { label: "80", value: 80 },
    { label: "100", value: 100 },
  ];

  return (
    <div className="space-y-4">
      <div className="relative h-4 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all duration-700"
          style={{
            width: `${currentScore}%`,
            background: `linear-gradient(90deg, ${currentColor}, ${targetColor})`,
            boxShadow: `0 0 12px ${currentColor}66`,
          }}
        />
        <div
          className="absolute inset-y-0 border-r-2 border-dashed"
          style={{ left: `${targetScore}%`, borderColor: targetColor }}
        />
      </div>

      <div className="flex justify-between items-end">
        <div>
          <p className="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider">
            Current
          </p>
          <p className="text-2xl font-extrabold" style={{ color: currentColor }}>
            {currentScore}
          </p>
          <p className="text-xs text-zinc-400">{currentTier}</p>
        </div>

        <div className="text-right">
          <p className="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider">
            Target
          </p>
          <p className="text-2xl font-extrabold" style={{ color: targetColor }}>
            {targetScore}
          </p>
          <p className="text-xs text-zinc-400">{targetTier}</p>
        </div>
      </div>

      <div className="flex justify-between text-[10px] text-zinc-600 font-mono">
        {tierBoundaries.map((b) => (
          <span key={b.value}>{b.label}</span>
        ))}
      </div>
    </div>
  );
}
