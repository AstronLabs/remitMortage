"use client";

/**
 * GasConfigPanel
 *
 * A collapsible "Advanced Settings" accordion that lives inside any
 * transaction modal.  It lets power users override Soroban resource limits
 * and the max fee before signing.
 *
 * Behaviour:
 *   - Collapsed by default; expand via the "Advanced Settings" toggle.
 *   - Once simulation has run, each field shows the simulation-derived
 *     estimate as placeholder text and in the comparison row.
 *   - A warning badge appears next to any field whose override value is
 *     strictly less than the simulation estimate — the transaction may fail
 *     if submitted with those values.
 *   - A global "⚠ Custom gas insufficient" banner is shown when at least one
 *     warning is active.
 *   - "Reset to defaults" clears all overrides in one click.
 *
 * Props:
 *   estimate     — SimulationEstimate from buildDepositTx / buildWithdrawTx.
 *                  When null the panel still renders but shows "—" in the
 *                  estimate column (before the user has run the simulation).
 *   value        — Controlled GasConfig state from the parent modal.
 *   onChange     — Parent setter, receives the updated GasConfig.
 *   disabled     — When true all inputs are read-only (e.g. during signing).
 */

import React, { useId, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Info,
  RotateCcw,
  ShieldAlert,
} from "lucide-react";
import type { GasConfig, SimulationEstimate } from "../../lib/soroban-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GasConfigPanelProps {
  estimate: SimulationEstimate | null;
  value: GasConfig;
  onChange: (cfg: GasConfig) => void;
  disabled?: boolean;
}

// Field descriptor — one row in the panel.
interface FieldDef {
  key: keyof GasConfig;
  label: string;
  estimateKey: keyof SimulationEstimate | null;
  unit: string;
  tooltip: string;
}

// ---------------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------------

const FIELDS: FieldDef[] = [
  {
    key: "maxFeeStroops",
    label: "Max Fee",
    estimateKey: null, // no direct sim counterpart — compared to minResourceFee
    unit: "stroops",
    tooltip:
      "Total transaction fee cap in stroops (1 XLM = 10,000,000 stroops). " +
      "Must be ≥ the network's minimum resource fee or the transaction will be rejected.",
  },
  {
    key: "resourceFeeStroops",
    label: "Resource Fee",
    estimateKey: "minResourceFeeStroops",
    unit: "stroops",
    tooltip:
      "Soroban-specific resource fee portion in stroops. " +
      "Setting this below the simulation estimate will cause the transaction to fail.",
  },
  {
    key: "instructions",
    label: "Instructions",
    estimateKey: "instructions",
    unit: "units",
    tooltip:
      "CPU instruction budget for Soroban execution. " +
      "Lower values may reject at runtime if the contract needs more.",
  },
  {
    key: "readBytes",
    label: "Read Bytes",
    estimateKey: "readBytes",
    unit: "bytes",
    tooltip: "Ledger read-byte budget. Under-sizing causes an out-of-budget error.",
  },
  {
    key: "writeBytes",
    label: "Write Bytes",
    estimateKey: "writeBytes",
    unit: "bytes",
    tooltip: "Ledger write-byte budget. Under-sizing causes an out-of-budget error.",
  },
  {
    key: "readEntries",
    label: "Read Entries",
    estimateKey: "readEntries",
    unit: "entries",
    tooltip: "Number of ledger entries the contract may read.",
  },
  {
    key: "writeEntries",
    label: "Write Entries",
    estimateKey: "writeEntries",
    unit: "entries",
    tooltip: "Number of ledger entries the contract may write.",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when `override` is a valid positive integer that is strictly
 * less than `simValue` (indicating the user's override is dangerously low).
 */
function isInsufficient(override: string | undefined, simValue: string | undefined): boolean {
  if (!override || override.trim() === "") return false;
  if (!simValue || simValue === "0") return false;
  const o = parseInt(override, 10);
  const s = parseInt(simValue, 10);
  if (isNaN(o) || isNaN(s)) return false;
  return o < s;
}

/**
 * Format a raw stroop count as "N stroops (≈ X XLM)" for the estimate column.
 */
function formatStroops(raw: string | undefined): string {
  if (!raw || raw === "0") return "0";
  const n = parseInt(raw, 10);
  if (isNaN(n)) return raw;
  const xlm = (n / 10_000_000).toFixed(7).replace(/\.?0+$/, "");
  return `${n.toLocaleString()} (≈ ${xlm} XLM)`;
}

/**
 * Format a raw numeric string with locale thousands separators.
 */
function formatNum(raw: string | undefined): string {
  if (!raw || raw === "0") return "0";
  const n = parseInt(raw, 10);
  return isNaN(n) ? raw : n.toLocaleString();
}

// ---------------------------------------------------------------------------
// Tooltip component
// ---------------------------------------------------------------------------

function Tooltip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label="Help"
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onFocus={() => setShow(true)}
        onBlur={() => setShow(false)}
        className="text-zinc-600 hover:text-zinc-400 transition-colors focus-visible:outline-none"
      >
        <Info className="w-3.5 h-3.5" />
      </button>
      {show && (
        <span
          role="tooltip"
          className="absolute left-5 top-0 z-50 w-64 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-300 shadow-xl leading-relaxed"
        >
          {text}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Warning badge
// ---------------------------------------------------------------------------

function WarningBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-[10px] font-bold text-amber-400 uppercase tracking-wider">
      <AlertTriangle className="w-3 h-3 shrink-0" />
      Low
    </span>
  );
}

// ---------------------------------------------------------------------------
// Single field row
// ---------------------------------------------------------------------------

interface FieldRowProps {
  field: FieldDef;
  estimate: SimulationEstimate | null;
  value: string;
  onChange: (val: string) => void;
  disabled: boolean;
  inputId: string;
}

function FieldRow({ field, estimate, value, onChange, disabled, inputId }: FieldRowProps) {
  const simValue = field.estimateKey ? estimate?.[field.estimateKey] : undefined;

  // For maxFeeStroops there's no direct sim key — compare against minResourceFee.
  const compareValue =
    field.key === "maxFeeStroops"
      ? estimate?.minResourceFeeStroops
      : simValue;

  const warn = isInsufficient(value, compareValue);

  const isStroop =
    field.key === "maxFeeStroops" || field.key === "resourceFeeStroops";

  const estDisplay = (() => {
    if (!estimate) return "—";
    if (field.key === "maxFeeStroops") return formatStroops(estimate.minResourceFeeStroops);
    if (!simValue) return "—";
    return isStroop ? formatStroops(simValue) : formatNum(simValue);
  })();

  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 py-2.5 border-b border-zinc-800/60 last:border-0">
      {/* Label + tooltip */}
      <div className="flex items-center gap-1.5 min-w-0">
        <label
          htmlFor={inputId}
          className="text-xs font-medium text-zinc-400 truncate cursor-pointer"
        >
          {field.label}
        </label>
        <Tooltip text={field.tooltip} />
      </div>

      {/* Sim estimate */}
      <div className="text-center min-w-[96px]">
        <span className="text-[11px] font-mono text-zinc-500 break-all">{estDisplay}</span>
      </div>

      {/* Override input + warning */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <input
            id={inputId}
            type="number"
            min={0}
            step={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder={
              field.estimateKey && estimate?.[field.estimateKey]
                ? estimate[field.estimateKey]
                : "auto"
            }
            aria-invalid={warn}
            aria-describedby={warn ? `${inputId}-warn` : undefined}
            className={`w-full rounded-lg border px-2.5 py-1.5 text-xs font-mono bg-zinc-950 text-zinc-100 placeholder-zinc-700 outline-none transition-colors disabled:opacity-40
              ${warn
                ? "border-amber-500/60 focus:border-amber-400"
                : "border-zinc-700 focus:border-cyan-500/60"
              }`}
          />
          {warn && <WarningBadge />}
        </div>
        {warn && (
          <p
            id={`${inputId}-warn`}
            role="alert"
            className="text-[10px] text-amber-400 leading-snug"
          >
            Below simulation estimate — tx may fail
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export default function GasConfigPanel({
  estimate,
  value,
  onChange,
  disabled = false,
}: GasConfigPanelProps) {
  const [open, setOpen] = useState(false);
  const uid = useId();

  // Compute whether any override is dangerously low.
  const warnings = FIELDS.filter((f) => {
    const override = value[f.key];
    const compareValue =
      f.key === "maxFeeStroops"
        ? estimate?.minResourceFeeStroops
        : f.estimateKey
          ? estimate?.[f.estimateKey]
          : undefined;
    return isInsufficient(override, compareValue);
  });
  const hasWarnings = warnings.length > 0;

  function handleFieldChange(key: keyof GasConfig, val: string) {
    onChange({ ...value, [key]: val });
  }

  function handleReset() {
    onChange({});
  }

  // Check whether the user has set any override at all.
  const hasOverrides = Object.values(value).some((v) => v !== undefined && v !== "");

  return (
    <div
      className={`rounded-xl border transition-colors ${
        open
          ? "border-zinc-700 bg-zinc-900/60"
          : hasWarnings
            ? "border-amber-500/40 bg-amber-500/5"
            : "border-zinc-800 bg-zinc-900/30"
      }`}
    >
      {/* Toggle header */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`${uid}-body`}
        className="w-full flex items-center justify-between px-4 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-500 rounded-xl"
      >
        <div className="flex items-center gap-2">
          <ShieldAlert
            className={`w-4 h-4 shrink-0 ${hasWarnings ? "text-amber-400" : "text-zinc-500"}`}
            aria-hidden="true"
          />
          <span className="text-xs font-semibold text-zinc-300">Advanced Settings</span>
          {hasOverrides && !hasWarnings && (
            <span className="inline-flex items-center rounded-full bg-cyan-500/15 border border-cyan-500/30 px-2 py-0.5 text-[10px] font-bold text-cyan-400 uppercase tracking-wider">
              Custom
            </span>
          )}
          {hasWarnings && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-[10px] font-bold text-amber-400 uppercase tracking-wider">
              <AlertTriangle className="w-3 h-3 shrink-0" />
              {warnings.length} warning{warnings.length > 1 ? "s" : ""}
            </span>
          )}
        </div>
        {open ? (
          <ChevronUp className="w-4 h-4 text-zinc-500 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronDown className="w-4 h-4 text-zinc-500 shrink-0" aria-hidden="true" />
        )}
      </button>

      {/* Expanded body */}
      {open && (
        <div id={`${uid}-body`} className="px-4 pb-4">
          {/* Global insufficient-gas banner */}
          {hasWarnings && (
            <div
              role="alert"
              className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5"
            >
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-xs text-amber-300 leading-snug">
                One or more overrides are below the simulation estimates.
                The transaction may be rejected by the network or revert on-chain.{" "}
                <a
                  href="/docs/gas-optimization"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-amber-200"
                >
                  Gas optimization guide
                </a>
              </p>
            </div>
          )}

          {/* Column headers */}
          <div className="grid grid-cols-[1fr_auto_1fr] gap-3 mb-1 px-0">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
              Parameter
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600 text-center w-24">
              Simulated
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
              Override
            </span>
          </div>

          {/* Field rows */}
          <div>
            {FIELDS.map((field) => (
              <FieldRow
                key={field.key}
                field={field}
                estimate={estimate}
                value={value[field.key] ?? ""}
                onChange={(v) => handleFieldChange(field.key, v)}
                disabled={disabled}
                inputId={`${uid}-${field.key}`}
              />
            ))}
          </div>

          {/* Footer: units legend + reset */}
          <div className="mt-3 flex items-center justify-between">
            <p className="text-[10px] text-zinc-600 leading-relaxed">
              Leave blank to use simulation defaults. &nbsp;Stroops: 1 XLM = 10,000,000.
            </p>
            {hasOverrides && (
              <button
                type="button"
                onClick={handleReset}
                disabled={disabled}
                className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-cyan-400 transition-colors disabled:opacity-40"
              >
                <RotateCcw className="w-3 h-3" />
                Reset
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
