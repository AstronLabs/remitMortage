"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useId, useState } from "react";
import { BarChart3, Table2 } from "lucide-react";
import type { ChartExportData } from "@/lib/chart-export";

type Cell = string | number;

interface AccessibleChartProps {
  /** Chart title; used for the table caption and announcements. */
  chartTitle: string;
  /** Concise trend summary shown above the chart (see `lib/chart-summary`). */
  summary: string;
  /**
   * The exact rows/columns the chart plots. Pass the same memoized object
   * that feeds the chart (and CSV export) so table and chart cannot drift.
   */
  data: ChartExportData;
  /** Active filter / time range, appended to the table caption (e.g. "Range: 1y"). */
  filterDescription?: string;
  /** Formats a body cell for display. Defaults to locale-formatted numbers. */
  formatCell?: (value: Cell, columnIndex: number) => string;
  /** The chart itself; kept mounted (hidden) while the table is shown. */
  children: React.ReactNode;
}

const defaultFormatCell = (value: Cell): string =>
  typeof value === "number"
    ? value.toLocaleString("en-US", { maximumFractionDigits: 4 })
    : String(value);

/**
 * Wraps a chart with a trend summary and a toggle that swaps the visual for
 * an equivalent data table. The table is a real `<table>` with a caption,
 * column headers and row headers, inside a focusable scroll region so it is
 * keyboard operable and announced correctly by screen readers.
 */
export default function AccessibleChart({
  chartTitle,
  summary,
  data,
  filterDescription,
  formatCell = defaultFormatCell,
  children,
}: AccessibleChartProps) {
  const [showTable, setShowTable] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const baseId = useId();
  const summaryId = `${baseId}-summary`;
  const tableRegionId = `${baseId}-table`;

  const toggle = () => {
    const next = !showTable;
    setShowTable(next);
    setAnnouncement(
      next
        ? `Showing ${chartTitle} as a data table with ${data.rows.length} rows.`
        : `Showing ${chartTitle} as a chart.`
    );
  };

  const caption = filterDescription ? `${chartTitle}. ${filterDescription}` : chartTitle;

  return (
    <div data-testid="accessible-chart">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <p id={summaryId} className="text-xs text-[var(--text-secondary,#94a3b8)]">
          {summary}
        </p>
        <button
          type="button"
          onClick={toggle}
          aria-pressed={showTable}
          aria-controls={tableRegionId}
          className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-cyan-500/50 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
        >
          {showTable ? (
            <BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Table2 className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {showTable ? "View as chart" : "View as table"}
          <span className="sr-only"> for {chartTitle}</span>
        </button>
      </div>

      <div hidden={showTable} aria-describedby={summaryId}>
        {children}
      </div>

      <div id={tableRegionId}>
        {showTable && (
          <div
            role="region"
            aria-label={`${chartTitle} data table`}
            tabIndex={0}
            className="max-h-[320px] overflow-auto rounded-lg border border-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
          >
            <table className="w-full border-collapse text-left text-xs text-slate-300">
              <caption className="sr-only">{caption}</caption>
              <thead className="sticky top-0 bg-slate-900">
                <tr>
                  {data.columns.map((column) => (
                    <th
                      key={column}
                      scope="col"
                      className="border-b border-slate-800 px-3 py-2 font-semibold text-slate-200"
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, rowIndex) => (
                  <tr key={rowIndex} className="border-b border-slate-800/60 last:border-0">
                    {row.map((value, columnIndex) =>
                      columnIndex === 0 ? (
                        <th
                          key={columnIndex}
                          scope="row"
                          className="px-3 py-1.5 font-medium text-slate-200"
                        >
                          {formatCell(value, columnIndex)}
                        </th>
                      ) : (
                        <td key={columnIndex} className="px-3 py-1.5 font-mono">
                          {formatCell(value, columnIndex)}
                        </td>
                      )
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
