"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useEffect, useState, useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Loader2 } from "lucide-react";

type TimeRange = "1m" | "6m" | "1y" | "Max";

const MIN_PROJECTION_MONTHS = 1;
const MAX_PROJECTION_MONTHS = 36;
const DEFAULT_PROJECTION_MONTHS = 12;

interface HistoricalYield {
  date: string;
  yieldUsdc: number;
}

interface ChartDataPoint {
  date: string;
  historicalValue: number | null;
  projectedValue: number | null;
}

interface ROIProjectionWidgetProps {
  wallet: string;
  depositedAmount: number;
  apyBps: number;
}

export default function ROIProjectionWidget({
  wallet,
  depositedAmount,
  apyBps,
}: ROIProjectionWidgetProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>("1y");
  // How many months of future repayment-driven yield to project — configurable
  // via the slider below the chart, independent of the historical view window.
  const [projectionMonths, setProjectionMonths] = useState(DEFAULT_PROJECTION_MONTHS);
  const [historicalData, setHistoricalData] = useState<HistoricalYield[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function fetchHistory() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/investor/historical?wallet=${encodeURIComponent(wallet)}`);
        if (!res.ok) throw new Error("Failed to load historical records");
        const json = await res.json();
        if (active) setHistoricalData(json);
      } catch (err: any) {
        if (active) setError(err.message || "Error fetching historical data");
      } finally {
        if (active) setLoading(false);
      }
    }
    fetchHistory();
    return () => {
      active = false;
    };
  }, [wallet]);

  const chartData = useMemo(() => {
    if (historicalData.length === 0) return [];
    
    // Base data with principal added to yield
    const data: ChartDataPoint[] = historicalData.map((d) => ({
      date: d.date,
      historicalValue: depositedAmount + d.yieldUsdc,
      projectedValue: null,
    }));

    // The last point of historical data is the current month
    const lastData = data[data.length - 1];
    
    // Connect the historical to projected
    const currentPrincipal = lastData.historicalValue as number;
    lastData.projectedValue = currentPrincipal;

    // Generate projections
    const rate = apyBps / 10000;
    
    // Project `projectionMonths` months into the future (slider-controlled).
    let projectedBalance = currentPrincipal;
    const [yearStr, monthStr] = lastData.date.split("-");
    let currentYear = parseInt(yearStr, 10);
    let currentMonth = parseInt(monthStr, 10); // 1-indexed

    for (let i = 1; i <= projectionMonths; i++) {
      currentMonth++;
      if (currentMonth > 12) {
        currentMonth = 1;
        currentYear++;
      }
      
      const dateStr = `${currentYear}-${String(currentMonth).padStart(2, "0")}`;
      
      // Compounding monthly: A = P(1 + r/12)^n
      projectedBalance = projectedBalance * (1 + rate / 12);
      
      data.push({
        date: dateStr,
        historicalValue: null,
        projectedValue: Number(projectedBalance.toFixed(2)),
      });
    }

    // Filter by time range
    const nowIndex = historicalData.length - 1;
    let startIndex = 0;
    let endIndex = data.length;

    if (timeRange === "1m") {
      startIndex = Math.max(0, nowIndex - 1);
      endIndex = nowIndex + 2;
    } else if (timeRange === "6m") {
      startIndex = Math.max(0, nowIndex - 6);
      endIndex = nowIndex + 7;
    } else if (timeRange === "1y") {
      startIndex = Math.max(0, nowIndex - 12);
      endIndex = nowIndex + 13;
    }

    return data.slice(startIndex, endIndex);
  }, [historicalData, depositedAmount, apyBps, timeRange, projectionMonths]);

  const formatCurrency = (val: number) => {
    return "$" + val.toLocaleString("en-US", { maximumFractionDigits: 0 });
  };

  return (
    <div className="p-6 bg-slate-900/80 rounded-2xl border border-slate-800 backdrop-blur-xl mt-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">
        <div>
          <h2 className="text-lg font-bold text-white mb-1">Portfolio ROI Projection</h2>
          <p className="text-xs text-slate-400">
            Compounding projections based on your active {((apyBps) / 100).toFixed(1)}% APY.
          </p>
        </div>

        <div className="flex p-1 bg-slate-950 border border-slate-800 rounded-lg shrink-0">
          {(["1m", "6m", "1y", "Max"] as TimeRange[]).map((tr) => (
            <button
              key={tr}
              onClick={() => setTimeRange(tr)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${
                timeRange === tr
                  ? "bg-indigo-500 text-white shadow-sm"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {tr}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-4 mb-6">
        <label htmlFor="projection-months" className="text-xs font-semibold text-slate-300 whitespace-nowrap">
          Repayment Timeline
        </label>
        <input
          id="projection-months"
          type="range"
          min={MIN_PROJECTION_MONTHS}
          max={MAX_PROJECTION_MONTHS}
          step={1}
          value={projectionMonths}
          onChange={(e) => setProjectionMonths(Number(e.target.value))}
          className="flex-1 accent-indigo-500"
          aria-label="Projected months of future repayment-driven yield"
        />
        <span className="text-xs font-mono text-indigo-400 w-20 text-right shrink-0">
          {projectionMonths} {projectionMonths === 1 ? "month" : "months"}
        </span>
      </div>

      <div className="h-[280px] w-full relative">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900/50 rounded-xl animate-pulse">
            <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
          </div>
        ) : error ? (
          <div className="absolute inset-0 flex items-center justify-center border border-red-500/20 bg-red-500/10 rounded-xl">
            <p className="text-xs text-red-400">{error}</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="colorHistory" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="colorProjected" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
              <XAxis 
                dataKey="date" 
                stroke="#64748b" 
                fontSize={12} 
                tickLine={false}
                axisLine={false}
              />
              <YAxis 
                stroke="#64748b" 
                fontSize={12}
                tickLine={false}
                axisLine={false}
                tickFormatter={formatCurrency}
              />
              <Tooltip 
                contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '8px' }}
                itemStyle={{ color: '#f8fafc' }}
                formatter={(value: number, name: string) => [
                  `$${value.toLocaleString("en-US", { minimumFractionDigits: 2 })}`, 
                  name === "historicalValue" ? "Historical Value" : "Projected Value"
                ]}
                labelStyle={{ color: '#94a3b8', marginBottom: '4px' }}
              />
              <Area 
                type="monotone" 
                dataKey="historicalValue" 
                stroke="#06b6d4" 
                strokeWidth={3}
                fill="url(#colorHistory)" 
                activeDot={{ r: 6, fill: '#06b6d4' }}
              />
              <Area 
                type="monotone" 
                dataKey="projectedValue" 
                stroke="#6366f1" 
                strokeWidth={3}
                strokeDasharray="5 5"
                fill="url(#colorProjected)" 
                activeDot={{ r: 6, fill: '#6366f1' }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
