"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useMemo, useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useContractRegistry } from "../context/ContractRegistryContext";
import {
  ESTIMATOR_MONTHS,
  bpsToPercent,
  estimateYield,
} from "../lib/yield-estimator";

interface YieldEstimatorCalculatorProps {
  /** Optional starting deposit (e.g. the borrower's current escrow balance). */
  initialAmount?: number;
}

const CURRENCY = (value: number) =>
  "$" + value.toLocaleString("en-US", { maximumFractionDigits: 0 });

const CURRENCY_PRECISE = (value: number) =>
  "$" +
  value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/**
 * Interactive APY / yield estimator. Reads the active escrow yield from the
 * contract registry context and projects monthly-compounding growth over a
 * 24-month timeline. All figures recompute synchronously (via useMemo) whenever
 * the deposit amount or duration changes, so the chart and summary update
 * instantly as the user types or drags.
 */
export default function YieldEstimatorCalculator({
  initialAmount = 10_000,
}: YieldEstimatorCalculatorProps) {
  const { escrowApyBps } = useContractRegistry();

  const [amount, setAmount] = useState<number>(
    initialAmount > 0 ? initialAmount : 10_000
  );
  const [months, setMonths] = useState<number>(ESTIMATOR_MONTHS);

  // Instant recomputation on every amount / duration / APY change.
  const estimate = useMemo(
    () => estimateYield(amount, escrowApyBps, months),
    [amount, escrowApyBps, months]
  );

  const chartData = useMemo(
    () =>
      estimate.timeline.map((point) => ({
        label: point.month === 0 ? "Now" : `M${point.month}`,
        balance: point.balance,
        earned: point.earned,
      })),
    [estimate]
  );

  function handleAmountChange(raw: string) {
    const parsed = Number(raw.replace(/,/g, ""));
    setAmount(Number.isFinite(parsed) && parsed >= 0 ? parsed : 0);
  }

  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 md:p-8 shadow-xl backdrop-blur-xl">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-6">
        <div>
          <h2 className="text-xl font-bold text-white">Yield &amp; APY Estimator</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Project compounding escrow yield over 24 months at the active{" "}
            <span className="text-emerald-400 font-mono font-semibold">
              {bpsToPercent(escrowApyBps, 1)}% APY
            </span>
            .
          </p>
        </div>
        <span className="text-xs font-mono font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1.5 rounded-full self-start">
          {bpsToPercent(estimate.effectiveApyBps, 2)}% effective (compounded)
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Controls + summary */}
        <div className="lg:col-span-2 space-y-5">
          <div>
            <label
              htmlFor="yield-amount"
              className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2"
            >
              Deposit Amount (USDC)
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 font-mono text-sm">
                $
              </span>
              <input
                id="yield-amount"
                type="number"
                min={0}
                step={100}
                inputMode="decimal"
                value={amount}
                onChange={(e) => handleAmountChange(e.target.value)}
                className="w-full pl-7 pr-3 py-2.5 rounded-xl bg-slate-950/60 border border-slate-800 text-white font-mono text-sm focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/30"
                aria-label="Deposit amount in USDC"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label
                htmlFor="yield-months"
                className="text-[10px] font-bold uppercase tracking-wider text-slate-400"
              >
                Duration
              </label>
              <span className="text-xs font-mono font-semibold text-cyan-400">
                {months} {months === 1 ? "month" : "months"}
              </span>
            </div>
            <input
              id="yield-months"
              type="range"
              min={1}
              max={ESTIMATOR_MONTHS}
              step={1}
              value={months}
              onChange={(e) => setMonths(Number(e.target.value))}
              className="w-full accent-cyan-500"
              aria-label="Projection duration in months"
            />
            <div className="flex justify-between text-[10px] text-slate-500 mt-1 font-mono">
              <span>1m</span>
              <span>{ESTIMATOR_MONTHS}m</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 pt-1">
            <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800">
              <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                Projected Balance
              </span>
              <div className="text-lg font-extrabold text-cyan-400 mt-1 font-mono">
                {CURRENCY_PRECISE(estimate.finalBalance)}
              </div>
            </div>
            <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800">
              <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                Yield Earned
              </span>
              <div className="text-lg font-extrabold text-emerald-400 mt-1 font-mono">
                {CURRENCY_PRECISE(estimate.totalEarned)}
              </div>
            </div>
          </div>
        </div>

        {/* Growth chart */}
        <div className="lg:col-span-3 h-[260px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={chartData}
              margin={{ top: 10, right: 10, left: -12, bottom: 0 }}
            >
              <defs>
                <linearGradient id="colorYieldBalance" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
              <XAxis
                dataKey="label"
                stroke="#64748b"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis
                stroke="#64748b"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                tickFormatter={CURRENCY}
                width={64}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#0f172a",
                  borderColor: "#1e293b",
                  borderRadius: "8px",
                }}
                itemStyle={{ color: "#f8fafc" }}
                labelStyle={{ color: "#94a3b8", marginBottom: "4px" }}
                formatter={(value: number, name: string) => [
                  CURRENCY_PRECISE(value),
                  name === "balance" ? "Balance" : "Earned",
                ]}
              />
              <Area
                type="monotone"
                dataKey="balance"
                stroke="#10b981"
                strokeWidth={3}
                fill="url(#colorYieldBalance)"
                activeDot={{ r: 5, fill: "#10b981" }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
