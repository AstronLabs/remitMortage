// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Plain-language chart summaries.
 *
 * Every chart exposes a one-sentence trend summary above it so screen-reader
 * users (and anyone skimming) get the headline without reading the data
 * table. Summaries are derived from the same rows the chart plots.
 */

export interface SummaryPoint {
  label: string;
  value: number;
}

export type ValueFormatter = (value: number) => string;

const defaultFormat: ValueFormatter = (value) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** Changes smaller than this (as a fraction of the starting value) read as "flat". */
const FLAT_THRESHOLD = 0.005;

/**
 * Summarize a time series: direction and size of change from first to last
 * point, plus the peak when it is not simply the last point.
 */
export function summarizeTrend(
  seriesName: string,
  points: SummaryPoint[],
  format: ValueFormatter = defaultFormat
): string {
  const usable = points.filter((p) => Number.isFinite(p.value));
  if (usable.length === 0) return `${seriesName}: no data available.`;

  const first = usable[0];
  const last = usable[usable.length - 1];
  if (usable.length === 1) {
    return `${seriesName}: ${format(first.value)} in ${first.label}.`;
  }

  const delta = last.value - first.value;
  const relative = first.value !== 0 ? delta / Math.abs(first.value) : delta === 0 ? 0 : Infinity;

  let movement: string;
  if (Math.abs(relative) < FLAT_THRESHOLD) {
    movement = `${seriesName} was flat at about ${format(last.value)}`;
  } else {
    const verb = delta > 0 ? "rose" : "fell";
    const pct = Number.isFinite(relative) ? ` ${(Math.abs(relative) * 100).toFixed(1)}%` : "";
    movement = `${seriesName} ${verb}${pct} from ${format(first.value)} in ${first.label} to ${format(last.value)} in ${last.label}`;
  }

  const peak = usable.reduce((best, p) => (p.value > best.value ? p : best), first);
  const peakNote =
    peak !== last && peak.value > Math.max(first.value, last.value)
      ? `, peaking at ${format(peak.value)} in ${peak.label}`
      : "";

  return `${movement}${peakNote}.`;
}

/** Summarize a share-of-total breakdown (e.g. a pie chart). */
export function summarizeShares(
  chartName: string,
  items: SummaryPoint[],
  format: ValueFormatter = (v) => `${defaultFormat(v)}%`
): string {
  const usable = items.filter((i) => Number.isFinite(i.value));
  if (usable.length === 0) return `${chartName}: no data available.`;

  const sorted = usable.slice().sort((a, b) => b.value - a.value);
  const [largest, ...rest] = sorted;
  const tail = rest.map((i) => `${i.label} ${format(i.value)}`).join(", ");
  return `${chartName}: ${largest.label} is the largest share at ${format(largest.value)}${
    tail ? `; ${tail}` : ""
  }.`;
}
