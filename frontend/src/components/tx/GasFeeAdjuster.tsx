"use client";

/**
 * GasFeeAdjuster
 *
 * Collapsible "Transaction Fee" panel for the deposit and withdrawal modals.
 *
 * - Collapsed by default; the header always shows the fee that will be sent.
 * - Standard / Fast / Instant presets are derived from the simulated resource
 *   fee, so the recommended value tracks real network conditions.
 * - A slider and a stroop input allow any value between the simulated minimum
 *   and 10x it; anything below the simulated resource fee raises a warning.
 * - "Use recommended" restores the Standard preset.
 */

import React, { useId, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Fuel, RotateCcw } from "lucide-react";
import type { SimulationEstimate } from "../../lib/soroban-client";
import {
  baselineFeeStroops,
  buildFeeOptions,
  feeSliderRange,
  feeToUsd,
  formatFee,
  isFeeBelowMinimum,
  matchFeeTier,
} from "../../lib/gas-fees";

interface GasFeeAdjusterProps {
  /** Simulation output; null until the first simulation resolves. */
  estimate: SimulationEstimate | null;
  /** Selected max fee in stroops, or null to follow the recommendation. */
  value: number | null;
  onChange: (stroops: number | null) => void;
  /** Latest XLM/USD price, used for the secondary USD readout. */
  xlmPriceUsd?: number | null;
  /** True while the estimate is being (re)computed. */
  loading?: boolean;
  disabled?: boolean;
  /** Set when the estimate came from the session cache rather than a fresh call. */
  fromCache?: boolean;
}

export default function GasFeeAdjuster({
  estimate,
  value,
  onChange,
  xlmPriceUsd = null,
  loading = false,
  disabled = false,
  fromCache = false,
}: GasFeeAdjusterProps) {
  const [open, setOpen] = useState(false);
  const uid = useId();

  const baseline = baselineFeeStroops(estimate);
  const options = buildFeeOptions(estimate);
  const { min, max, step } = feeSliderRange(estimate);
  const effectiveFee = value ?? baseline;
  const activeTier = matchFeeTier(effectiveFee, estimate);
  const belowMinimum = isFeeBelowMinimum(effectiveFee, estimate);
  const isCustom = value !== null && activeTier === null;
  const usd = feeToUsd(effectiveFee, xlmPriceUsd);

  function handleSlider(event: React.ChangeEvent<HTMLInputElement>) {
    onChange(Number(event.target.value));
  }

  function handleInput(event: React.ChangeEvent<HTMLInputElement>) {
    const raw = event.target.value;
    if (raw.trim() === "") {
      onChange(null);
      return;
    }
    const parsed = Number.parseInt(raw, 10);
    onChange(Number.isFinite(parsed) ? parsed : null);
  }

  return (
    <div
      data-testid="gas-fee-adjuster"
      className={`rounded-xl border transition-colors ${
        belowMinimum
          ? "border-amber-500/40 bg-amber-500/5"
          : "border-[var(--border-color)] bg-[var(--bg-secondary)]"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-controls={`${uid}-body`}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2">
          <Fuel className="h-4 w-4 shrink-0 text-[var(--accent-primary)]" aria-hidden="true" />
          <span className="text-sm font-semibold text-[var(--text-primary)]">
            Transaction Fee
          </span>
          {activeTier && (
            <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cyan-400">
              {options.find((option) => option.tier === activeTier)?.label}
            </span>
          )}
          {isCustom && (
            <span className="rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-indigo-300">
              Custom
            </span>
          )}
        </span>

        <span className="flex items-center gap-2">
          <span className="font-mono text-xs text-[var(--text-secondary)]">
            {loading && !estimate ? "Simulating…" : formatFee(effectiveFee)}
          </span>
          {open ? (
            <ChevronUp className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
          )}
        </span>
      </button>

      {open && (
        <div id={`${uid}-body`} className="space-y-4 px-4 pb-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
            <span>
              Simulated resource fee:{" "}
              <span className="font-mono text-[var(--text-secondary)]">
                {estimate ? formatFee(Number(estimate.minResourceFeeStroops)) : "—"}
              </span>
            </span>
            {fromCache && <span>Cached from this session</span>}
          </div>

          <div className="grid grid-cols-3 gap-2">
            {options.map((option) => {
              const selected = effectiveFee === option.stroops;
              return (
                <button
                  key={option.tier}
                  type="button"
                  data-testid={`fee-tier-${option.tier}`}
                  onClick={() => onChange(option.stroops)}
                  disabled={disabled}
                  aria-pressed={selected}
                  title={option.description}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-40 ${
                    selected
                      ? "border-[var(--accent-primary)] bg-[var(--accent-primary)]/10"
                      : "border-[var(--border-color)] bg-[var(--bg-primary)] hover:border-[var(--accent-primary)]/50"
                  }`}
                >
                  <span className="block text-xs font-semibold text-[var(--text-primary)]">
                    {option.label}
                  </span>
                  <span className="mt-0.5 block font-mono text-[10px] text-[var(--text-muted)]">
                    {option.stroops.toLocaleString()}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="space-y-2">
            <label
              htmlFor={`${uid}-slider`}
              className="block text-xs font-medium text-[var(--text-secondary)]"
            >
              Max fee (stroops)
            </label>
            <input
              id={`${uid}-slider`}
              type="range"
              min={min}
              max={max}
              step={step}
              value={Math.min(Math.max(effectiveFee, min), max)}
              onChange={handleSlider}
              disabled={disabled}
              className="w-full accent-[var(--accent-primary)] disabled:opacity-40"
            />
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={0}
                step={1}
                value={value ?? ""}
                placeholder={String(baseline)}
                onChange={handleInput}
                disabled={disabled}
                aria-label="Custom max fee in stroops"
                aria-invalid={belowMinimum}
                className={`w-40 rounded-lg border bg-[var(--bg-primary)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-primary)] outline-none transition-colors disabled:opacity-40 ${
                  belowMinimum
                    ? "border-amber-500/60 focus:border-amber-400"
                    : "border-[var(--border-color)] focus:border-[var(--accent-primary)]"
                }`}
              />
              {usd && (
                <span className="text-xs text-[var(--text-muted)]">≈ ${usd}</span>
              )}
              {value !== null && (
                <button
                  type="button"
                  onClick={() => onChange(null)}
                  disabled={disabled}
                  className="ml-auto inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--accent-primary)] disabled:opacity-40"
                >
                  <RotateCcw className="h-3 w-3" aria-hidden="true" />
                  Use recommended
                </button>
              )}
            </div>
          </div>

          {belowMinimum && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-300"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              This fee is below the simulated resource fee. The network will
              reject the transaction unless you raise it.{" "}
              <a
                href="/docs/gas-optimization"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-amber-200"
              >
                Learn more
              </a>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
