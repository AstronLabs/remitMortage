"use client";

import React, { useMemo, useState } from "react";
import { usePortfolioBreakdown } from "../hooks/usePortfolioBreakdown";
import {
  segmentKey,
  sumSegments,
  type LoanAllocation,
  type PortfolioSegment,
  type RiskTier,
  type Tranche,
} from "../lib/portfolioBreakdown";

const TRANCHES: Tranche[] = ["Senior", "Junior"];
const RISK_TIERS: RiskTier[] = ["Low", "Medium", "High"];

/** Risk tier is a reserved status scale (good/warning/critical), shared across tranches. */
const RISK_TIER_COLOR: Record<RiskTier, string> = {
  Low: "#10b981", // emerald-500
  Medium: "#f59e0b", // amber-500
  High: "#f43f5e", // rose-500
};

const RISK_TIER_TEXT_CLASS: Record<RiskTier, string> = {
  Low: "text-emerald-400",
  Medium: "text-amber-400",
  High: "text-rose-400",
};

function formatUSDC(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface SelectedSegment {
  tranche: Tranche;
  riskTier: RiskTier;
}

interface PortfolioBreakdownChartProps {
  wallet: string | null;
  /** Optional override; defaults to the investor's on-chain deposited balance. */
  totalDeposited?: number;
}

export default function PortfolioBreakdownChart({
  wallet,
  totalDeposited,
}: PortfolioBreakdownChartProps) {
  const { data, loading, error } = usePortfolioBreakdown(wallet, totalDeposited);
  const [selected, setSelected] = useState<SelectedSegment | null>(null);

  const segmentsByTranche = useMemo(() => {
    const map = new Map<Tranche, PortfolioSegment[]>();
    for (const tranche of TRANCHES) map.set(tranche, []);
    for (const segment of data?.segments ?? []) {
      map.get(segment.tranche)?.push(segment);
    }
    return map;
  }, [data]);

  const trancheTotals = useMemo(() => {
    const totals = new Map<Tranche, number>();
    for (const tranche of TRANCHES) {
      totals.set(tranche, sumSegments(segmentsByTranche.get(tranche) ?? []));
    }
    return totals;
  }, [segmentsByTranche]);

  const grandTotal = data?.totalDeposited ?? 0;

  const selectedLoans: LoanAllocation[] = useMemo(() => {
    if (!selected || !data) return [];
    return (
      data.segments.find(
        (s) => s.tranche === selected.tranche && s.riskTier === selected.riskTier
      )?.loans ?? []
    );
  }, [selected, data]);

  if (!wallet) return null;

  if (loading) {
    return (
      <div className="p-6 bg-slate-900/80 rounded-2xl border border-slate-800 backdrop-blur-xl text-sm text-slate-400">
        Loading portfolio breakdown…
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-500/10 text-red-300 border border-red-500/20 rounded-2xl text-sm">
        {error}
      </div>
    );
  }

  if (!data || grandTotal <= 0) {
    return (
      <div className="p-6 bg-slate-900/80 rounded-2xl border border-slate-800 backdrop-blur-xl text-sm text-slate-400">
        No deposited capital to break down yet.
      </div>
    );
  }

  return (
    <div className="p-6 bg-slate-900/80 rounded-2xl border border-slate-800 backdrop-blur-xl space-y-6">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-2">
        <div>
          <h3 className="text-lg font-bold text-white">Portfolio Diversification</h3>
          <p className="text-xs text-slate-400">
            Deposited capital by tranche and underlying borrower risk tier.
          </p>
        </div>
        <p className="text-sm font-mono text-slate-300">
          Total: <span className="text-white font-bold">${formatUSDC(grandTotal)}</span>
        </p>
      </div>

      {/* Status legend — risk tier meaning is shared across both tranche bars below. */}
      <div className="flex items-center gap-4 text-xs font-semibold">
        {RISK_TIERS.map((tier) => (
          <div key={tier} className="flex items-center gap-1.5">
            <span
              className="w-3 h-3 rounded-full inline-block"
              style={{ backgroundColor: RISK_TIER_COLOR[tier] }}
            />
            <span className="text-slate-300">{tier} Risk</span>
          </div>
        ))}
      </div>

      <div className="space-y-5">
        {TRANCHES.map((tranche) => {
          const segments = (segmentsByTranche.get(tranche) ?? [])
            .slice()
            .sort((a, b) => RISK_TIERS.indexOf(a.riskTier) - RISK_TIERS.indexOf(b.riskTier));
          const trancheTotal = trancheTotals.get(tranche) ?? 0;
          if (trancheTotal <= 0) return null;

          const rowWidthPct = Math.min(100, (trancheTotal / grandTotal) * 100);

          return (
            <div key={tranche} data-testid={`tranche-row-${tranche}`}>
              <div className="flex justify-between text-xs text-slate-300 font-semibold mb-1.5">
                <span>{tranche} Tranche</span>
                <span className="font-mono text-white">${formatUSDC(trancheTotal)}</span>
              </div>

              <div
                className="w-full bg-slate-950 rounded-full h-6 border border-slate-800 overflow-hidden"
                aria-label={`${tranche} tranche breakdown: $${formatUSDC(trancheTotal)} across ${segments.length} risk tiers`}
              >
                <div className="flex h-full gap-0.5" style={{ width: `${rowWidthPct}%` }}>
                  {segments.map((segment) => {
                    const widthPct = (segment.amount / trancheTotal) * 100;
                    const isSelected =
                      selected?.tranche === segment.tranche && selected?.riskTier === segment.riskTier;
                    return (
                      <button
                        key={segmentKey(segment.tranche, segment.riskTier)}
                        type="button"
                        onClick={() =>
                          setSelected(
                            isSelected ? null : { tranche: segment.tranche, riskTier: segment.riskTier }
                          )
                        }
                        title={`${segment.tranche} · ${segment.riskTier} Risk — $${formatUSDC(segment.amount)} (${segment.loans.length} loans)`}
                        aria-pressed={isSelected}
                        style={{
                          width: `${widthPct}%`,
                          backgroundColor: RISK_TIER_COLOR[segment.riskTier],
                          opacity: isSelected || !selected ? 1 : 0.4,
                        }}
                        className="h-full min-w-[3px] rounded-sm transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                      />
                    );
                  })}
                </div>
              </div>

              {/* Direct labels: amounts don't reliably fit inside narrow segments, so
                  they live here instead, doubling as the drill-down trigger. */}
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5">
                {segments.map((segment) => {
                  const isSelected =
                    selected?.tranche === segment.tranche && selected?.riskTier === segment.riskTier;
                  return (
                    <button
                      key={segmentKey(segment.tranche, segment.riskTier)}
                      type="button"
                      onClick={() =>
                        setSelected(
                          isSelected ? null : { tranche: segment.tranche, riskTier: segment.riskTier }
                        )
                      }
                      className={`text-[11px] font-mono flex items-center gap-1 hover:underline ${
                        isSelected ? "text-white font-bold" : RISK_TIER_TEXT_CLASS[segment.riskTier]
                      }`}
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full inline-block"
                        style={{ backgroundColor: RISK_TIER_COLOR[segment.riskTier] }}
                      />
                      {segment.riskTier}: ${formatUSDC(segment.amount)}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {selected && (
        <div className="p-4 bg-slate-950/60 border border-slate-800 rounded-xl space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-bold text-white">
              {selected.tranche} · {selected.riskTier} Risk
              <span className="text-slate-400 font-normal ml-2">
                ({selectedLoans.length} loan{selectedLoans.length === 1 ? "" : "s"})
              </span>
            </h4>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="text-xs text-cyan-400 hover:underline"
            >
              Clear
            </button>
          </div>

          <div className="space-y-2">
            {selectedLoans.map((loan) => (
              <div
                key={loan.loanId}
                className="flex items-center justify-between gap-4 p-3 bg-slate-900/60 rounded-lg border border-slate-800"
              >
                <div>
                  <p className="font-mono text-xs font-semibold text-white">
                    {loan.borrower.slice(0, 8)}...{loan.borrower.slice(-4)}
                  </p>
                  <p className="text-[11px] text-slate-400">{loan.region}</p>
                </div>
                <div className="text-right">
                  <p className="font-mono text-sm font-bold text-white">
                    ${formatUSDC(loan.allocatedAmount)}
                  </p>
                  <p className="text-[11px] text-slate-400">{(loan.apyBps / 100).toFixed(1)}% APY</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
