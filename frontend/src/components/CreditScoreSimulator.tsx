"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState, useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Area,
  AreaChart,
  Legend,
} from "recharts";

type CreditTier = "Insufficient" | "Fair" | "Good" | "Excellent";

interface SimulationDataPoint {
  month: number;
  score: number;
  tier: CreditTier;
  interestRate: number;
}

export default function CreditScoreSimulator() {
  // Input states
  const [monthlyPayment, setMonthlyPayment] = useState<number>(500);
  const [consistency, setConsistency] = useState<number>(95);
  const [duration, setDuration] = useState<number>(12);

  // Credit tier boundaries
  const TIER_THRESHOLDS = {
    Excellent: { min: 80, rate: 3.5, color: "#10b981" },
    Good: { min: 60, rate: 4.8, color: "#06b6d4" },
    Fair: { min: 40, rate: 6.2, color: "#f59e0b" },
    Insufficient: { min: 0, rate: 8.5, color: "#ef4444" },
  };

  // Calculate score progression over time
  const simulationData = useMemo((): SimulationDataPoint[] => {
    const data: SimulationDataPoint[] = [];

    for (let month = 0; month <= duration; month++) {
      // Progressive scoring (builds up over time)
      const consistencyScore = Math.min(40, (40 * consistency) / 100);
      const frequencyScore = 25; // Assuming monthly payments
      const durationScore = Math.min(20, (month / 12) * 20);
      const volumeScore = Math.min(
        15,
        monthlyPayment * month >= 5000
          ? 15
          : monthlyPayment * month >= 2000
            ? 10
            : monthlyPayment * month >= 500
              ? 5
              : 0
      );

      const totalScore = Math.min(
        100,
        consistencyScore + frequencyScore + durationScore + volumeScore
      );

      let tier: CreditTier = "Insufficient";
      let interestRate = 8.5;

      if (totalScore >= 80) {
        tier = "Excellent";
        interestRate = 3.5;
      } else if (totalScore >= 60) {
        tier = "Good";
        interestRate = 4.8;
      } else if (totalScore >= 40) {
        tier = "Fair";
        interestRate = 6.2;
      }

      data.push({
        month,
        score: Math.round(totalScore),
        tier,
        interestRate,
      });
    }

    return data;
  }, [monthlyPayment, consistency, duration]);

  // Current score at selected duration
  const currentScore = simulationData[duration];

  // Custom tooltip
  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-slate-900 border border-slate-700 rounded-lg p-3 shadow-xl">
          <p className="text-slate-300 text-xs font-semibold mb-1">Month {data.month}</p>
          <p className="text-white font-bold text-lg">{data.score} points</p>
          <p className="text-cyan-400 text-xs">{data.tier} Tier</p>
          <p className="text-slate-400 text-xs mt-1">{data.interestRate}% interest rate</p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="p-8 bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl backdrop-blur-xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-white mb-2">Credit Score Simulator</h2>
        <p className="text-slate-400 text-sm">
          Adjust your remittance parameters to see how consistent payments build credit over time
        </p>
      </div>

      {/* Interactive Controls */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div>
          <label className="text-slate-300 font-semibold text-sm block mb-2">
            Monthly Payment: ${monthlyPayment}
          </label>
          <input
            type="range"
            min="100"
            max="2000"
            step="50"
            value={monthlyPayment}
            onChange={(e) => setMonthlyPayment(Number(e.target.value))}
            className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
          />
          <div className="flex justify-between text-xs text-slate-500 mt-1">
            <span>$100</span>
            <span>$2000</span>
          </div>
        </div>

        <div>
          <label className="text-slate-300 font-semibold text-sm block mb-2">
            Payment Consistency: {consistency}%
          </label>
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={consistency}
            onChange={(e) => setConsistency(Number(e.target.value))}
            className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
          />
          <div className="flex justify-between text-xs text-slate-500 mt-1">
            <span>0%</span>
            <span>100%</span>
          </div>
        </div>

        <div>
          <label className="text-slate-300 font-semibold text-sm block mb-2">
            Duration: {duration} months
          </label>
          <input
            type="range"
            min="1"
            max="24"
            step="1"
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
          />
          <div className="flex justify-between text-xs text-slate-500 mt-1">
            <span>1mo</span>
            <span>24mo</span>
          </div>
        </div>
      </div>

      {/* Credit Score Graph */}
      <div className="mb-6 p-6 bg-slate-950/60 border border-slate-800 rounded-xl">
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={simulationData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="scoreGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis
              dataKey="month"
              stroke="#94a3b8"
              tick={{ fill: "#94a3b8", fontSize: 12 }}
              label={{ value: "Months", position: "insideBottom", offset: -5, fill: "#94a3b8" }}
            />
            <YAxis
              stroke="#94a3b8"
              tick={{ fill: "#94a3b8", fontSize: 12 }}
              domain={[0, 100]}
              label={{ value: "Credit Score", angle: -90, position: "insideLeft", fill: "#94a3b8" }}
            />
            <Tooltip content={<CustomTooltip />} />

            {/* Tier boundary lines */}
            <ReferenceLine
              y={80}
              stroke={TIER_THRESHOLDS.Excellent.color}
              strokeDasharray="3 3"
              label={{ value: "Excellent", fill: TIER_THRESHOLDS.Excellent.color, fontSize: 10 }}
            />
            <ReferenceLine
              y={60}
              stroke={TIER_THRESHOLDS.Good.color}
              strokeDasharray="3 3"
              label={{ value: "Good", fill: TIER_THRESHOLDS.Good.color, fontSize: 10 }}
            />
            <ReferenceLine
              y={40}
              stroke={TIER_THRESHOLDS.Fair.color}
              strokeDasharray="3 3"
              label={{ value: "Fair", fill: TIER_THRESHOLDS.Fair.color, fontSize: 10 }}
            />

            <Area
              type="monotone"
              dataKey="score"
              stroke="#06b6d4"
              strokeWidth={3}
              fill="url(#scoreGradient)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Current Score Display */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div
          className="p-5 rounded-xl border"
          style={{
            backgroundColor: `${TIER_THRESHOLDS[currentScore.tier].color}10`,
            borderColor: `${TIER_THRESHOLDS[currentScore.tier].color}30`,
          }}
        >
          <p className="text-slate-400 text-xs font-semibold uppercase mb-1">Projected Score</p>
          <p className="text-white text-3xl font-extrabold">{currentScore.score}</p>
          <p
            className="text-sm font-semibold mt-1"
            style={{ color: TIER_THRESHOLDS[currentScore.tier].color }}
          >
            {currentScore.tier} Tier
          </p>
        </div>

        <div className="p-5 rounded-xl bg-slate-950/60 border border-slate-800">
          <p className="text-slate-400 text-xs font-semibold uppercase mb-1">Interest Rate</p>
          <p className="text-white text-3xl font-extrabold">{currentScore.interestRate}%</p>
          <p className="text-slate-400 text-sm mt-1">APR</p>
        </div>

        <div className="p-5 rounded-xl bg-slate-950/60 border border-slate-800">
          <p className="text-slate-400 text-xs font-semibold uppercase mb-1">Total Paid</p>
          <p className="text-white text-3xl font-extrabold">
            ${(monthlyPayment * duration).toLocaleString()}
          </p>
          <p className="text-slate-400 text-sm mt-1">Over {duration} months</p>
        </div>
      </div>

      {/* Tier Legend */}
      <div className="mt-6 p-4 bg-slate-950/40 border border-slate-800 rounded-lg">
        <p className="text-slate-300 font-semibold text-xs mb-3">Credit Tiers</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Object.entries(TIER_THRESHOLDS).map(([tier, config]) => (
            <div key={tier} className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: config.color }} />
              <div>
                <p className="text-white text-xs font-semibold">{tier}</p>
                <p className="text-slate-400 text-[10px]">
                  {config.min}+ pts → {config.rate}% APR
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
