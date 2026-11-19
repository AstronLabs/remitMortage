"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useMemo } from "react";

export type DateRange = { start: string; end: string };
export type DateRangePreset = "7" | "30" | "90" | "ytd" | "custom";

function localDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getPresetRange(
  preset: Exclude<DateRangePreset, "custom">,
  now = new Date()
): DateRange {
  const end = localDate(now);
  if (preset === "ytd") return { start: `${now.getFullYear()}-01-01`, end };
  const start = new Date(now);
  start.setDate(start.getDate() - (Number(preset) - 1));
  return { start: localDate(start), end };
}

export function validateDateRange(range: DateRange) {
  return !range.start || !range.end || range.start <= range.end;
}

export default function DateRangePicker({
  value,
  onChange,
}: {
  value: DateRange;
  onChange: (range: DateRange) => void;
}) {
  const presets = useMemo(
    () =>
      [
        ["7", "Last 7 days"],
        ["30", "Last 30 days"],
        ["90", "Last 90 days"],
        ["ytd", "Year to date"],
      ] as const,
    []
  );
  const invalid = !validateDateRange(value);

  return (
    <fieldset
      className="date-range-picker space-y-3"
      aria-describedby={invalid ? "date-range-error" : undefined}
    >
      <legend className="sr-only">Date range</legend>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Date range presets">
        {presets.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="btn-outline-blue text-xs"
            onClick={() => onChange(getPresetRange(id as Exclude<DateRangePreset, "custom">))}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-xs font-semibold">
          Start date
          <input
            aria-label="Start date"
            type="date"
            value={value.start}
            onChange={(event) => onChange({ ...value, start: event.target.value })}
            className="mt-1 w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2"
          />
        </label>
        <label className="text-xs font-semibold">
          End date
          <input
            aria-label="End date"
            type="date"
            value={value.end}
            onChange={(event) => onChange({ ...value, end: event.target.value })}
            className="mt-1 w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2"
          />
        </label>
      </div>
      {invalid && (
        <p id="date-range-error" role="alert" className="text-xs text-red-400">
          Start date must be on or before end date.
        </p>
      )}
    </fieldset>
  );
}
