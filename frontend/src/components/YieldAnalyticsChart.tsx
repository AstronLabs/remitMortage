"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useEffect, useState } from "react";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface HistoricalData {
  date: string;
  tvl: number;
  apy: number;
}

export default function YieldAnalyticsChart() {
  const [data, setData] = useState<HistoricalData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch("/api/analytics/historical");
        if (!res.ok) throw new Error("Failed to fetch historical data");
        const json = await res.json();
        setData(json);
      } catch (err: unknown) {
        if (err instanceof Error) {
          setError(err.message);
        } else {
          setError(String(err));
        }
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  const formatCurrency = (value: number) => {
    if (value >= 1000000) return `$${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`;
    return `$${value}`;
  };

  const formatPercent = (value: number) => {
    return `${value.toFixed(1)}%`;
  };

  if (error) {
    return (
      <div className="p-6 bg-slate-900/70 border border-slate-800/80 rounded-2xl">
        <p className="text-red-400 text-sm">Error loading charts: {error}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
      {/* TVL Area Chart */}
      <div className="p-6 bg-slate-900/70 border border-slate-800/80 backdrop-blur-xl rounded-2xl flex flex-col">
        <h3 className="text-lg font-bold text-white mb-1">Total Value Locked (USDC)</h3>
        <p className="text-xs text-slate-400 mb-6">Historical TVL growth over time.</p>
        
        <div className="flex-1 min-h-[250px] relative">
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center bg-slate-900/50 rounded-xl animate-pulse">
              <div className="w-full h-full bg-slate-800/50 rounded-xl"></div>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorTvl" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
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
                  itemStyle={{ color: '#06b6d4' }}
                  formatter={(value: number) => [`$${value.toLocaleString()}`, 'TVL']}
                />
                <Area 
                  type="monotone" 
                  dataKey="tvl" 
                  stroke="#06b6d4" 
                  strokeWidth={3}
                  fillOpacity={1} 
                  fill="url(#colorTvl)" 
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* APY Line Chart */}
      <div className="p-6 bg-slate-900/70 border border-slate-800/80 backdrop-blur-xl rounded-2xl flex flex-col">
        <h3 className="text-lg font-bold text-white mb-1">Estimated Pool APY</h3>
        <p className="text-xs text-slate-400 mb-6">Average historical yield for lenders.</p>
        
        <div className="flex-1 min-h-[250px] relative">
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center bg-slate-900/50 rounded-xl animate-pulse">
              <div className="w-full h-full bg-slate-800/50 rounded-xl"></div>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
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
                  tickFormatter={formatPercent}
                />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '8px' }}
                  itemStyle={{ color: '#10b981' }}
                  formatter={(value: number) => [`${value.toFixed(2)}%`, 'APY']}
                />
                <Line 
                  type="monotone" 
                  dataKey="apy" 
                  stroke="#10b981" 
                  strokeWidth={3}
                  dot={{ fill: '#10b981', r: 4 }}
                  activeDot={{ r: 6 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
