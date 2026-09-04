"use client";

import React, { useState, useMemo } from "react";
import FieldTooltip from "./ui/FieldTooltip";

// Types
type FrequencyOption =
  "Weekly" | "Bi-weekly" | "Monthly" | "Bi-monthly" | "Quarterly" | "Irregular";
type MortgageTermOption = 15 | 20 | 30;

export default function CreditCalculator() {
  // ─── Input States ──────────────────────────────────────────────────────────
  const [monthlyRemittance, setMonthlyRemittance] = useState<number>(500);
  const [consistency, setConsistency] = useState<number>(95);
  const [sendingHistory, setSendingHistory] = useState<number>(12);
  const [frequency, setFrequency] = useState<FrequencyOption>("Monthly");
  const [purchasePrice, setPurchasePrice] = useState<number>(250000);
  const [mortgageTerm, setMortgageTerm] = useState<MortgageTermOption>(30);

  // ─── Safe Input Parsing & Clamping ─────────────────────────────────────────
  const safeRemittance = useMemo(() => Math.max(0, monthlyRemittance || 0), [monthlyRemittance]);
  const safeConsistency = useMemo(
    () => Math.min(100, Math.max(0, consistency || 0)),
    [consistency]
  );
  const safeHistory = useMemo(() => Math.max(0, sendingHistory || 0), [sendingHistory]);
  const safePurchasePrice = useMemo(() => Math.max(0, purchasePrice || 0), [purchasePrice]);

  // ─── Credit Score & Tier Calculations ──────────────────────────────────────
  const { score, consistencyScore, frequencyScore, durationScore, volumeScore, tier } =
    useMemo(() => {
      // 1. Consistency Score (Max 40)
      const cScore = Math.round(40 * (safeConsistency / 100));

      // 2. Frequency Score (Max 25)
      let fScore = 0;
      if (frequency === "Weekly" || frequency === "Bi-weekly" || frequency === "Monthly") {
        fScore = 25;
      } else if (frequency === "Bi-monthly") {
        fScore = 15;
      } else if (frequency === "Quarterly") {
        fScore = 5;
      }

      // 3. Duration Score (Max 20)
      let dScore = 0;
      if (safeHistory >= 12) {
        dScore = 20;
      } else if (safeHistory >= 6) {
        dScore = 10;
      } else if (safeHistory >= 3) {
        dScore = 5;
      }

      // 4. Volume Score (Max 15)
      const totalVolume = safeRemittance * safeHistory;
      let vScore = 0;
      if (totalVolume >= 5000) {
        vScore = 15;
      } else if (totalVolume >= 2000) {
        vScore = 10;
      } else if (totalVolume >= 500) {
        vScore = 5;
      }

      const totalScore = Math.min(100, cScore + fScore + dScore + vScore);

      let classification = "Insufficient";
      if (totalScore >= 80) {
        classification = "Excellent";
      } else if (totalScore >= 60) {
        classification = "Good";
      } else if (totalScore >= 40) {
        classification = "Fair";
      }

      return {
        score: totalScore,
        consistencyScore: cScore,
        frequencyScore: fScore,
        durationScore: dScore,
        volumeScore: vScore,
        tier: classification,
      };
    }, [safeConsistency, frequency, safeHistory, safeRemittance]);

  // ─── Mortgage Parameters by Tier ──────────────────────────────────────────
  const tierConfig = useMemo(() => {
    switch (tier) {
      case "Excellent":
        return {
          rate: 3.5,
          downPaymentPct: 10,
          maxLoan: 600000,
          color: "#10b981",
          bg: "bg-emerald-500/10",
          border: "border-emerald-500/30",
        };
      case "Good":
        return {
          rate: 4.8,
          downPaymentPct: 20,
          maxLoan: 400000,
          color: "#06b6d4",
          bg: "bg-cyan-500/10",
          border: "border-cyan-500/30",
        };
      case "Fair":
        return {
          rate: 6.2,
          downPaymentPct: 30,
          maxLoan: 250000,
          color: "#f59e0b",
          bg: "bg-amber-500/10",
          border: "border-amber-500/30",
        };
      case "Insufficient":
      default:
        return {
          rate: 8.5,
          downPaymentPct: 50,
          maxLoan: 75000,
          color: "#ef4444",
          bg: "bg-red-500/10",
          border: "border-red-500/30",
        };
    }
  }, [tier]);

  // ─── Amortization Calculations ─────────────────────────────────────────────
  const { downPaymentRequired, maxLoanPrincipal, actualLoanAmount, monthlyPayment, isCapped } =
    useMemo(() => {
      const downPaymentPct = tierConfig.downPaymentPct;
      const initialDownPayment = (safePurchasePrice * downPaymentPct) / 100;
      const initialLoan = safePurchasePrice - initialDownPayment;

      // Check if the loan exceeds the maximum allowed principal for this tier
      const isLoanCapped = initialLoan > tierConfig.maxLoan;
      const actualLoan = isLoanCapped ? tierConfig.maxLoan : initialLoan;
      const actualDownPayment = safePurchasePrice - actualLoan;

      // Amortization calculation
      const r = tierConfig.rate / 12 / 100; // monthly rate
      const n = mortgageTerm * 12; // total payments
      let payment = 0;

      if (actualLoan > 0) {
        if (r > 0) {
          payment = (actualLoan * (r * Math.pow(1 + r, n))) / (Math.pow(1 + r, n) - 1);
        } else {
          payment = actualLoan / n;
        }
      }

      return {
        downPaymentRequired: actualDownPayment,
        maxLoanPrincipal: tierConfig.maxLoan,
        actualLoanAmount: actualLoan,
        monthlyPayment: Math.round(payment * 100) / 100,
        isCapped: isLoanCapped,
      };
    }, [safePurchasePrice, tierConfig, mortgageTerm]);

  // ─── SVG Chart Data (Rate vs. History for fixed consistency/volume) ────────
  const chartPoints = useMemo(() => {
    const points = [];
    const steps = [3, 6, 12, 18, 24, 30, 36];
    for (const h of steps) {
      const cScore = Math.round(40 * (safeConsistency / 100));
      let fScore = 0;
      if (frequency === "Weekly" || frequency === "Bi-weekly" || frequency === "Monthly") {
        fScore = 25;
      } else if (frequency === "Bi-monthly") {
        fScore = 15;
      } else if (frequency === "Quarterly") {
        fScore = 5;
      }

      let dScore = 0;
      if (h >= 12) {
        dScore = 20;
      } else if (h >= 6) {
        dScore = 10;
      } else if (h >= 3) {
        dScore = 5;
      }

      const totalVolume = safeRemittance * h;
      let vScore = 0;
      if (totalVolume >= 5000) {
        vScore = 15;
      } else if (totalVolume >= 2000) {
        vScore = 10;
      } else if (totalVolume >= 500) {
        vScore = 5;
      }

      const tempScore = cScore + fScore + dScore + vScore;
      let tempRate = 8.5;
      if (tempScore >= 80) tempRate = 3.5;
      else if (tempScore >= 60) tempRate = 4.8;
      else if (tempScore >= 40) tempRate = 6.2;

      points.push({ months: h, rate: tempRate });
    }
    return points;
  }, [safeConsistency, frequency, safeRemittance]);

  // SVG dimensions & mapping
  const width = 500;
  const height = 180;
  const padding = 35;

  const svgCoordinates = useMemo(() => {
    const minMonths = 3;
    const maxMonths = 36;
    const minRate = 3.0;
    const maxRate = 9.0;

    const getX = (months: number) =>
      padding + ((months - minMonths) / (maxMonths - minMonths)) * (width - 2 * padding);
    const getY = (rate: number) =>
      height - padding - ((rate - minRate) / (maxRate - minRate)) * (height - 2 * padding);

    const path = chartPoints
      .map((p, idx) => `${idx === 0 ? "M" : "L"} ${getX(p.months)} ${getY(p.rate)}`)
      .join(" ");

    const currentX = getX(Math.min(36, Math.max(3, safeHistory)));
    const currentY = getY(tierConfig.rate);

    return { path, currentX, currentY, getX, getY };
  }, [chartPoints, safeHistory, tierConfig]);

  return (
    <div className="p-6 md:p-8 animate-fade-in-up w-full bg-[#0D1536] border border-white/10 rounded-2xl relative overflow-hidden shadow-xl">
      {/* Decorative inner glow */}
      <div className="absolute top-0 right-0 w-[30%] h-[30%] bg-blue-500/10 rounded-full blur-[90px] pointer-events-none" />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* ─── LEFT: Inputs ─── */}
        <div className="space-y-6">
          <div>
            <h3 className="text-lg font-bold text-slate-100 mb-1">Mortgage Calculator</h3>
            <p className="text-xs text-slate-400">
              Configure your remittance performance parameters and desired purchase metrics.
            </p>
          </div>

          <div className="space-y-5">
            {/* Monthly Remittance */}
            <div className="bg-slate-950/40 p-4 rounded-xl border border-slate-800/40">
              <div className="flex justify-between items-center mb-2">
                <label className="text-sm font-semibold text-slate-300">Monthly Remittance</label>
                <span className="text-sm font-bold text-indigo-400 font-mono">
                  ${safeRemittance.toLocaleString()} USDC
                </span>
              </div>
              <input
                type="range"
                min="50"
                max="5000"
                step="50"
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                value={monthlyRemittance}
                onChange={(e) => setMonthlyRemittance(Number(e.target.value))}
              />
              <div className="flex justify-between text-[10px] text-slate-500 mt-1.5 font-mono">
                <span>$50</span>
                <span>$2,500</span>
                <span>$5,000</span>
              </div>
            </div>

            {/* Consistency Percentage */}
            <div className="bg-slate-950/40 p-4 rounded-xl border border-slate-800/40">
              <div className="flex justify-between items-center mb-2">
                <label className="text-sm font-semibold text-slate-300 flex items-center gap-1.5">
                  Remittance Consistency
                  <FieldTooltip content="The percentage of months where you sent remittances on time. Higher consistency significantly boosts your credit score (weighted 40% in the scoring formula)." />
                </label>
                <span className="text-sm font-bold text-cyan-400 font-mono">
                  {safeConsistency}% On-Time
                </span>
              </div>
              <input
                type="range"
                min="10"
                max="100"
                step="1"
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                value={consistency}
                onChange={(e) => setConsistency(Number(e.target.value))}
              />
              <div className="flex justify-between text-[10px] text-slate-500 mt-1.5 font-mono">
                <span>10% Irregular</span>
                <span>50% Moderate</span>
                <span>100% Strict</span>
              </div>
            </div>

            {/* Sending History (Months) */}
            <div className="bg-slate-950/40 p-4 rounded-xl border border-slate-800/40">
              <div className="flex justify-between items-center mb-2">
                <label className="text-sm font-semibold text-slate-300 flex items-center gap-1.5">
                  Payment History Duration
                  <FieldTooltip content="How long you've been consistently sending remittances. Longer history demonstrates reliability and unlocks higher credit scores and lower interest rates." />
                </label>
                <span className="text-sm font-bold text-emerald-400 font-mono">
                  {safeHistory} Months
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="36"
                step="1"
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                value={sendingHistory}
                onChange={(e) => setSendingHistory(Number(e.target.value))}
              />
              <div className="flex justify-between text-[10px] text-slate-500 mt-1.5 font-mono">
                <span>0m</span>
                <span>12m (1 Yr)</span>
                <span>24m (2 Yrs)</span>
                <span>36m (3 Yrs)</span>
              </div>
            </div>

            {/* Remittance Frequency */}
            <div>
              <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                Frequency Pattern
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    "Weekly",
                    "Bi-weekly",
                    "Monthly",
                    "Bi-monthly",
                    "Quarterly",
                    "Irregular",
                  ] as FrequencyOption[]
                ).map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setFrequency(opt)}
                    className={`py-2 px-1 text-xs font-semibold rounded-lg border transition-all duration-200 ${
                      frequency === opt
                        ? "bg-indigo-600/20 border-indigo-500/50 text-indigo-300 shadow-md"
                        : "bg-[#060a13]/60 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700"
                    }`}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>

            {/* Target Home Price */}
            <div className="border-t border-slate-800/80 pt-4">
              <div className="flex justify-between items-center mb-2">
                <label className="text-sm font-semibold text-slate-300 flex items-center gap-1.5">
                  Target Purchase Price
                  <FieldTooltip content="The total price of the property you intend to purchase. Your down payment target is 30% of this amount, accumulated in your escrow savings account." />
                </label>
                <span className="text-sm font-bold text-indigo-400 font-mono">
                  ${safePurchasePrice.toLocaleString()} USDC
                </span>
              </div>
              <input
                type="range"
                min="20000"
                max="800000"
                step="10000"
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                value={purchasePrice}
                onChange={(e) => setPurchasePrice(Number(e.target.value))}
              />
              <div className="flex justify-between text-[10px] text-slate-500 mt-1.5 font-mono">
                <span>$20,000</span>
                <span>$400,000</span>
                <span>$800,000</span>
              </div>
            </div>

            {/* Mortgage Term */}
            <div>
              <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                Repayment Term Length
              </label>
              <div className="flex gap-2">
                {([15, 20, 30] as MortgageTermOption[]).map((term) => (
                  <button
                    key={term}
                    type="button"
                    onClick={() => setMortgageTerm(term)}
                    className={`flex-1 py-2 text-xs font-semibold rounded-lg border transition-all duration-200 ${
                      mortgageTerm === term
                        ? "bg-indigo-600/20 border-indigo-500/50 text-indigo-300 shadow-md"
                        : "bg-[#060a13]/60 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700"
                    }`}
                  >
                    {term} Years
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ─── RIGHT: Outputs & Visuals ─── */}
        <div className="space-y-6">
          {/* Projected Score & Tier badge */}
          <div className="bg-[#060a13]/80 border border-slate-800 rounded-2xl p-5 flex flex-col sm:flex-row items-center gap-6 relative">
            {/* Radial score gauge */}
            <div className="relative w-24 h-24 flex items-center justify-center shrink-0">
              <svg className="w-full h-full transform -rotate-90">
                <circle
                  cx="48"
                  cy="48"
                  r="40"
                  className="stroke-slate-900 fill-transparent"
                  strokeWidth="6"
                />
                <circle
                  cx="48"
                  cy="48"
                  r="40"
                  strokeDasharray={251.2}
                  strokeDashoffset={251.2 - (251.2 * score) / 100}
                  stroke={tierConfig.color}
                  fill="transparent"
                  className="transition-all duration-500 ease-out"
                  strokeWidth="6"
                  strokeLinecap="round"
                />
              </svg>
              <div className="absolute text-center">
                <div className="text-2xl font-extrabold text-slate-100">{score}</div>
                <div className="text-[8px] text-slate-400 tracking-wider uppercase font-bold">
                  Score
                </div>
              </div>
            </div>

            {/* Score Details */}
            <div className="flex-1 text-center sm:text-left">
              <span className="text-[10px] text-slate-500 font-bold tracking-wider uppercase">
                Stellar Credit Rating
              </span>
              <div className="flex items-center justify-center sm:justify-start gap-2 mt-0.5 mb-2">
                <h4 className="text-xl font-bold text-slate-100">{tier} Tier</h4>
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full animate-pulse"
                  style={{ backgroundColor: tierConfig.color }}
                />
              </div>

              {/* Dynamic Tier helper text */}
              <p className="text-xs text-slate-400 leading-relaxed">
                {tier === "Excellent" &&
                  "🎉 Unlocks prime down-payments and our lowest rate (3.50% APR)."}
                {tier === "Good" &&
                  "👍 Satisfies standard mortgage criteria. Premium interest parameters apply."}
                {tier === "Fair" &&
                  "⚠️ Requires slightly higher savings ratio. Higher APR applied."}
                {tier === "Insufficient" &&
                  "❌ Requires longer remittance history or higher consistent volumes."}
              </p>
            </div>
          </div>

          {/* Detailed Score Formula */}
          <div className="space-y-3 bg-[#060a13]/40 border border-slate-800 rounded-xl p-4">
            <h4 className="text-[10px] font-bold text-slate-500 tracking-widest uppercase">
              Score Attribution Weights
            </h4>

            <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
              {/* Consistency */}
              <div>
                <div className="flex justify-between text-[11px] text-slate-400 mb-1 font-semibold">
                  <span>Consistency (40%)</span>
                  <span>{consistencyScore}/40</span>
                </div>
                <div className="w-full bg-slate-900 h-1 rounded-full overflow-hidden">
                  <div
                    className="bg-indigo-500 h-full rounded-full"
                    style={{ width: `${(consistencyScore / 40) * 100}%` }}
                  />
                </div>
              </div>

              {/* Frequency */}
              <div>
                <div className="flex justify-between text-[11px] text-slate-400 mb-1 font-semibold">
                  <span>Frequency (25%)</span>
                  <span>{frequencyScore}/25</span>
                </div>
                <div className="w-full bg-slate-900 h-1 rounded-full overflow-hidden">
                  <div
                    className="bg-cyan-500 h-full rounded-full"
                    style={{ width: `${(frequencyScore / 25) * 100}%` }}
                  />
                </div>
              </div>

              {/* Duration */}
              <div>
                <div className="flex justify-between text-[11px] text-slate-400 mb-1 font-semibold">
                  <span>Duration (20%)</span>
                  <span>{durationScore}/20</span>
                </div>
                <div className="w-full bg-slate-900 h-1 rounded-full overflow-hidden">
                  <div
                    className="bg-emerald-500 h-full rounded-full"
                    style={{ width: `${(durationScore / 20) * 100}%` }}
                  />
                </div>
              </div>

              {/* Volume */}
              <div>
                <div className="flex justify-between text-[11px] text-slate-400 mb-1 font-semibold">
                  <span>Volume (15%)</span>
                  <span>{volumeScore}/15</span>
                </div>
                <div className="w-full bg-slate-900 h-1 rounded-full overflow-hidden">
                  <div
                    className="bg-amber-500 h-full rounded-full"
                    style={{ width: `${(volumeScore / 15) * 100}%` }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* ─── Financial Outputs Grid ─── */}
          <div className="grid grid-cols-2 gap-4">
            {/* Interest Rate */}
            <div className="bg-[#060a13]/80 border border-slate-800/80 rounded-xl p-4 text-center">
              <span className="block text-[10px] text-slate-500 font-bold tracking-wider uppercase mb-1">
                Interest Rate (APR)
              </span>
              <span className="text-2xl font-bold text-slate-100">
                {tierConfig.rate.toFixed(2)}%
              </span>
            </div>

            {/* Monthly Amortization */}
            <div className="bg-[#060a13]/80 border border-indigo-500/20 rounded-xl p-4 text-center ring-1 ring-indigo-500/10">
              <span className="block text-[10px] text-slate-500 font-bold tracking-wider uppercase mb-1">
                Projected Monthly Payout
              </span>
              <span className="text-2xl font-bold text-indigo-400">
                $
                {monthlyPayment.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
            </div>

            {/* Down Payment */}
            <div className="bg-[#060a13]/80 border border-slate-800/80 rounded-xl p-4 text-center">
              <span className="block text-[10px] text-slate-500 font-bold tracking-wider uppercase mb-1">
                Escrow Target (Down Payment)
              </span>
              <span className="text-xl font-bold text-slate-100">
                ${downPaymentRequired.toLocaleString()}
              </span>
              <span className="block text-[9px] text-slate-400 mt-0.5">
                ({tierConfig.downPaymentPct}% Ratio Required)
              </span>
            </div>

            {/* Max Loan Limit */}
            <div className="bg-[#060a13]/80 border border-slate-800/80 rounded-xl p-4 text-center">
              <span className="block text-[10px] text-slate-500 font-bold tracking-wider uppercase mb-1">
                Max Loan Capacity
              </span>
              <span className="text-xl font-bold text-slate-100">
                ${maxLoanPrincipal.toLocaleString()}
              </span>
              <span className="block text-[9px] text-slate-400 mt-0.5">for {tier} rating</span>
            </div>
          </div>

          {/* Capped Loan warning */}
          {isCapped && (
            <div className="bg-red-950/20 border border-red-800/30 text-red-300 p-3.5 rounded-xl text-xs leading-normal">
              ⚠️ <strong>Maximum Loan Cap Exceeded:</strong> The desired loan principal exceeds the
              limit of ${maxLoanPrincipal.toLocaleString()} allowed for your tier. Your savings
              escrow target has been increased to ${downPaymentRequired.toLocaleString()} to cover
              the purchase difference.
            </div>
          )}

          {/* ─── Interest Rate Curve SVG Chart ─── */}
          <div className="bg-[#060a13]/80 border border-slate-800/80 rounded-xl p-4">
            <h4 className="text-[10px] font-bold text-slate-500 tracking-wider uppercase mb-3 text-center">
              Rate Sensitivity Profile vs. History Duration
            </h4>
            <div className="relative flex justify-center">
              <svg
                width="100%"
                height={height}
                viewBox={`0 0 ${width} ${height}`}
                className="overflow-visible"
              >
                {/* Horizontal Grid lines */}
                {[3.5, 4.8, 6.2, 8.5].map((rate) => {
                  const y = svgCoordinates.getY(rate);
                  return (
                    <g key={rate}>
                      <line
                        x1={padding}
                        y1={y}
                        x2={width - padding}
                        y2={y}
                        stroke="rgba(99, 102, 241, 0.05)"
                        strokeDasharray="4 4"
                      />
                      <text
                        x={padding - 8}
                        y={y + 3}
                        fill="#64748b"
                        fontSize="8"
                        textAnchor="end"
                        className="font-mono font-bold"
                      >
                        {rate.toFixed(1)}%
                      </text>
                    </g>
                  );
                })}

                {/* X Axis Labels */}
                {[3, 6, 12, 18, 24, 30, 36].map((m) => {
                  const x = svgCoordinates.getX(m);
                  return (
                    <g key={m}>
                      <text
                        x={x}
                        y={height - padding + 15}
                        fill="#64748b"
                        fontSize="8"
                        textAnchor="middle"
                        className="font-mono font-bold"
                      >
                        {m}m
                      </text>
                    </g>
                  );
                })}

                {/* The Rate Line */}
                <path
                  d={svgCoordinates.path}
                  fill="none"
                  stroke="url(#chart-gradient)"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="transition-all duration-500 ease-out"
                />

                {/* Glow under the line */}
                <path
                  d={svgCoordinates.path}
                  fill="none"
                  stroke="rgb(99, 102, 241)"
                  strokeWidth="5"
                  strokeOpacity="0.1"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="transition-all duration-500 ease-out"
                />

                {/* Current User Highlight Dot */}
                <circle
                  cx={svgCoordinates.currentX}
                  cy={svgCoordinates.currentY}
                  r="6"
                  fill="#818cf8"
                  stroke="#0b0f19"
                  strokeWidth="2.5"
                  className="transition-all duration-300 ease-out"
                />
                <circle
                  cx={svgCoordinates.currentX}
                  cy={svgCoordinates.currentY}
                  r="10"
                  fill="none"
                  stroke="#818cf8"
                  strokeWidth="1.5"
                  strokeOpacity="0.3"
                  className="animate-ping"
                  style={{
                    transformOrigin: `${svgCoordinates.currentX}px ${svgCoordinates.currentY}px`,
                  }}
                />

                {/* Gradients */}
                <defs>
                  <linearGradient id="chart-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#ef4444" />
                    <stop offset="40%" stopColor="#f59e0b" />
                    <stop offset="80%" stopColor="#06b6d4" />
                    <stop offset="100%" stopColor="#10b981" />
                  </linearGradient>
                </defs>
              </svg>
            </div>
            <p className="text-[9px] text-center text-slate-500 mt-3 font-medium">
              Adjust the slider on the left to see the rates and details update in real-time.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
