"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState, useMemo } from "react";

export interface LoanGeoItem {
  id: string;
  borrower: string;
  principal: number;
  region: string;
  lat: number;
  lng: number;
  delinquencyRate: number; // 0 to 1 (e.g. 0.02 = 2%)
  riskTier: "Low" | "Medium" | "High";
  status: "Active" | "Delinquent" | "In Grace";
}

interface ActiveLoansMapViewProps {
  loans?: LoanGeoItem[];
  onSelectRegion?: (region: string | null) => void;
  selectedRegion?: string | null;
}

const DEFAULT_MOCK_LOANS: LoanGeoItem[] = [
  {
    id: "loan-101",
    borrower: "GBORROWER1NA1111111111111111111111111111111111111111",
    principal: 250000,
    region: "North America",
    lat: 38.0,
    lng: -97.0,
    delinquencyRate: 0.01,
    riskTier: "Low",
    status: "Active",
  },
  {
    id: "loan-102",
    borrower: "GBORROWER2NA2222222222222222222222222222222222222222",
    principal: 180000,
    region: "North America",
    lat: 41.5,
    lng: -87.6,
    delinquencyRate: 0.02,
    riskTier: "Low",
    status: "Active",
  },
  {
    id: "loan-103",
    borrower: "GBORROWER3EU1111111111111111111111111111111111111111",
    principal: 320000,
    region: "Europe",
    lat: 51.5,
    lng: -0.12,
    delinquencyRate: 0.07,
    riskTier: "Medium",
    status: "In Grace",
  },
  {
    id: "loan-104",
    borrower: "GBORROWER4EU2222222222222222222222222222222222222222",
    principal: 140000,
    region: "Europe",
    lat: 48.8,
    lng: 2.35,
    delinquencyRate: 0.04,
    riskTier: "Medium",
    status: "Active",
  },
  {
    id: "loan-105",
    borrower: "GBORROWER5AP1111111111111111111111111111111111111111",
    principal: 410000,
    region: "Asia Pacific",
    lat: 35.6,
    lng: 139.6,
    delinquencyRate: 0.14,
    riskTier: "High",
    status: "Delinquent",
  },
  {
    id: "loan-106",
    borrower: "GBORROWER6LATAM1111111111111111111111111111111111111",
    principal: 95000,
    region: "Latin America",
    lat: -23.5,
    lng: -46.6,
    delinquencyRate: 0.03,
    riskTier: "Low",
    status: "Active",
  },
];

interface RegionCluster {
  region: string;
  count: number;
  totalPrincipal: number;
  avgDelinquency: number;
  riskTier: "Low" | "Medium" | "High";
  x: number;
  y: number;
  loans: LoanGeoItem[];
}

export default function ActiveLoansMapView({
  loans = DEFAULT_MOCK_LOANS,
  onSelectRegion,
  selectedRegion: externalSelectedRegion,
}: ActiveLoansMapViewProps) {
  const [internalSelectedRegion, setInternalSelectedRegion] = useState<string | null>(null);

  const activeRegion = externalSelectedRegion !== undefined ? externalSelectedRegion : internalSelectedRegion;

  const handleRegionClick = (region: string) => {
    const next = activeRegion === region ? null : region;
    if (onSelectRegion) {
      onSelectRegion(next);
    } else {
      setInternalSelectedRegion(next);
    }
  };

  const clusters = useMemo<RegionCluster[]>(() => {
    const regionMap: Record<string, LoanGeoItem[]> = {};

    loans.forEach((loan) => {
      if (!regionMap[loan.region]) {
        regionMap[loan.region] = [];
      }
      regionMap[loan.region].push(loan);
    });

    const coordinates: Record<string, { x: number; y: number }> = {
      "North America": { x: 25, y: 35 },
      Europe: { x: 50, y: 30 },
      "Asia Pacific": { x: 78, y: 45 },
      "Latin America": { x: 33, y: 70 },
      "Africa & ME": { x: 55, y: 60 },
    };

    return Object.entries(regionMap).map(([region, items]) => {
      const count = items.length;
      const totalPrincipal = items.reduce((acc, cur) => acc + cur.principal, 0);
      const avgDelinquency = items.reduce((acc, cur) => acc + cur.delinquencyRate, 0) / count;

      let riskTier: "Low" | "Medium" | "High" = "Low";
      if (avgDelinquency > 0.1 || items.some((i) => i.riskTier === "High")) {
        riskTier = "High";
      } else if (avgDelinquency > 0.05 || items.some((i) => i.riskTier === "Medium")) {
        riskTier = "Medium";
      }

      const pos = coordinates[region] || { x: 50, y: 50 };

      return {
        region,
        count,
        totalPrincipal,
        avgDelinquency,
        riskTier,
        x: pos.x,
        y: pos.y,
        loans: items,
      };
    });
  }, [loans]);

  const filteredLoans = useMemo(() => {
    if (!activeRegion) return loans;
    return loans.filter((loan) => loan.region === activeRegion);
  }, [loans, activeRegion]);

  return (
    <div className="bg-[var(--bg-card,#0f172a)] rounded-2xl border border-[var(--border-color,#1e293b)] p-6 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h3 className="text-xl font-bold text-white flex items-center gap-2">
            <span>🗺️ Active Loan Geographic Distribution</span>
            {activeRegion && (
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
                Filtered: {activeRegion}
              </span>
            )}
          </h3>
          <p className="text-xs text-[var(--text-muted,#94a3b8)]">
            Click on a region cluster to filter the active loan portfolio list.
          </p>
        </div>

        <div className="flex items-center gap-4 text-xs font-semibold">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-full bg-emerald-500 inline-block" />
            <span className="text-slate-300">Low Risk (&lt;5% Delinq)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-full bg-amber-500 inline-block" />
            <span className="text-slate-300">Med Risk (5-10%)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-full bg-rose-500 inline-block" />
            <span className="text-slate-300">High Risk (&gt;10%)</span>
          </div>
        </div>
      </div>

      {/* SVG Interactive Map Canvas */}
      <div className="relative w-full h-80 bg-slate-950/80 rounded-xl border border-slate-800 overflow-hidden flex items-center justify-center">
        <svg viewBox="0 0 100 100" className="w-full h-full object-cover opacity-20">
          <path
            d="M 15 20 Q 25 15 35 25 T 30 50 T 20 40 Z M 45 20 Q 55 15 60 30 T 52 45 T 42 35 Z M 70 25 Q 85 20 90 40 T 75 60 T 65 40 Z M 25 60 Q 35 55 38 75 T 28 90 T 20 75 Z M 50 55 Q 60 50 62 70 T 52 85 T 45 70 Z"
            fill="currentColor"
            className="text-cyan-600"
          />
        </svg>

        {/* Region Clusters */}
        {clusters.map((cluster) => {
          const isSelected = activeRegion === cluster.region;

          let colorClass = "bg-emerald-500 border-emerald-300 text-emerald-950 shadow-emerald-500/50";
          if (cluster.riskTier === "High") {
            colorClass = "bg-rose-500 border-rose-300 text-rose-950 shadow-rose-500/50";
          } else if (cluster.riskTier === "Medium") {
            colorClass = "bg-amber-500 border-amber-300 text-amber-950 shadow-amber-500/50";
          }

          return (
            <button
              key={cluster.region}
              onClick={() => handleRegionClick(cluster.region)}
              style={{ left: `${cluster.x}%`, top: `${cluster.y}%` }}
              className={`absolute transform -translate-x-1/2 -translate-y-1/2 transition-all duration-300 group cursor-pointer ${
                isSelected ? "scale-125 z-20" : "hover:scale-110 z-10"
              }`}
              title={`${cluster.region}: ${cluster.count} Active Loans, ${(cluster.avgDelinquency * 100).toFixed(1)}% Delinquency`}
            >
              <div
                className={`flex items-center justify-center w-11 h-11 rounded-full border-2 shadow-lg font-bold text-sm ${colorClass} ${
                  isSelected ? "ring-4 ring-cyan-400 ring-offset-2 ring-offset-slate-900" : ""
                }`}
              >
                {cluster.count}
              </div>

              {/* Tooltip / Label */}
              <div className="absolute top-12 left-1/2 transform -translate-x-1/2 whitespace-nowrap bg-slate-900/90 border border-slate-700 px-2.5 py-1 rounded-md text-[11px] font-semibold text-slate-200 shadow-md pointer-events-none transition-opacity">
                <span>{cluster.region}</span>
                <span className="text-slate-400 ml-1">(${ (cluster.totalPrincipal / 1000).toFixed(0) }k)</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Filtered Loan List */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-bold text-slate-300">
            {activeRegion ? `Active Loans in ${activeRegion}` : "All Portfolio Active Loans"} ({filteredLoans.length})
          </h4>
          {activeRegion && (
            <button
              onClick={() => handleRegionClick(activeRegion)}
              className="text-xs text-cyan-400 hover:underline"
            >
              Reset Region Filter
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filteredLoans.map((loan) => (
            <div
              key={loan.id}
              className="p-4 bg-slate-900/60 rounded-xl border border-slate-800 flex items-center justify-between gap-4"
            >
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-mono text-xs font-semibold text-white">
                    {loan.borrower.slice(0, 8)}...{loan.borrower.slice(-4)}
                  </span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-300">
                    {loan.region}
                  </span>
                </div>
                <p className="text-xs text-slate-400">
                  Principal: <span className="font-semibold text-white">${loan.principal.toLocaleString()}</span>
                </p>
              </div>

              <div className="text-right">
                <span
                  className={`inline-block px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ${
                    loan.status === "Active"
                      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                      : loan.status === "In Grace"
                      ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                      : "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                  }`}
                >
                  {loan.status}
                </span>
                <p className="text-[11px] text-slate-400 mt-1">
                  Delinq: {(loan.delinquencyRate * 100).toFixed(1)}%
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
