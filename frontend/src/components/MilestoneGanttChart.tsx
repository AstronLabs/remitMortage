"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState, useMemo } from "react";

export type GanttMilestoneStatus =
  | "Proposed"
  | "Voting"
  | "Approved"
  | "Disbursed"
  | "Disputed";

export interface GanttMilestone {
  id: string;
  title: string;
  status: GanttMilestoneStatus;
  startDate: string;
  endDate: string;
  progress: number;
  votesFor: number;
  votesAgainst: number;
  votesTotal: number;
  description?: string;
}

interface TooltipData {
  x: number;
  y: number;
  milestone: GanttMilestone;
}

const STATUS_COLORS: Record<GanttMilestoneStatus, { bar: string; bg: string; text: string }> = {
  Proposed: { bar: "#6366f1", bg: "rgba(99,102,241,0.12)", text: "#818cf8" },
  Voting: { bar: "#f59e0b", bg: "rgba(245,158,11,0.12)", text: "#fbbf24" },
  Approved: { bar: "#10b981", bg: "rgba(16,185,129,0.12)", text: "#34d399" },
  Disbursed: { bar: "#06b6d4", bg: "rgba(6,182,212,0.12)", text: "#22d3ee" },
  Disputed: { bar: "#ef4444", bg: "rgba(239,68,68,0.12)", text: "#f87171" },
};

const STATUS_ORDER: GanttMilestoneStatus[] = [
  "Proposed",
  "Voting",
  "Approved",
  "Disbursed",
  "Disputed",
];

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  return Math.max(1, Math.ceil((db - da) / (1000 * 60 * 60 * 24)));
}

function getStatusIndex(status: GanttMilestoneStatus): number {
  return STATUS_ORDER.indexOf(status);
}

interface MilestoneGanttChartProps {
  milestones: GanttMilestone[];
  title?: string;
}

export function MilestoneGanttChart({ milestones, title }: MilestoneGanttChartProps) {
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [sortBy, setSortBy] = useState<"start" | "status" | "title">("start");

  const sorted = useMemo(() => {
    const copy = [...milestones];
    if (sortBy === "start") {
      copy.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
    } else if (sortBy === "status") {
      copy.sort((a, b) => getStatusIndex(a.status) - getStatusIndex(b.status));
    } else {
      copy.sort((a, b) => a.title.localeCompare(b.title));
    }
    return copy;
  }, [milestones, sortBy]);

  if (milestones.length === 0) return null;

  const minDate = new Date(
    Math.min(...milestones.map((m) => new Date(m.startDate).getTime()))
  );
  const maxDate = new Date(
    Math.max(...milestones.map((m) => new Date(m.endDate).getTime()))
  );
  const totalDays = daysBetween(
    minDate.toISOString().split("T")[0],
    maxDate.toISOString().split("T")[0]
  );

  function getBarOffset(startDate: string): number {
    const offset = daysBetween(minDate.toISOString().split("T")[0], startDate);
    return (offset / totalDays) * 100;
  }

  function getBarWidth(startDate: string, endDate: string): number {
    const dur = daysBetween(startDate, endDate);
    return (dur / totalDays) * 100;
  }

  const LABEL_WIDTH = 180;
  const HEADER_HEIGHT = 50;
  const ROW_HEIGHT = 48;
  const CHART_HEIGHT = sorted.length * ROW_HEIGHT + HEADER_HEIGHT + 20;

  function handleMouseEnter(e: React.MouseEvent, milestone: GanttMilestone) {
    const rect = (e.target as SVGElement).closest("svg")?.getBoundingClientRect();
    if (!rect) return;
    setTooltip({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      milestone,
    });
  }

  function handleMouseLeave() {
    setTooltip(null);
  }

  return (
    <section className="w-full rounded-[var(--radius-lg)] border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 md:p-6">
      <div className="flex items-center justify-between mb-4">
        {title && <h2 className="text-lg font-bold text-[var(--text-primary)]">{title}</h2>}
        {!title && <div />}
        <label className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          Sort
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as "start" | "status" | "title")}
            className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-[var(--radius-sm)] px-2.5 py-1 text-xs text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent-primary)]"
            data-testid="sort-select"
          >
          <option value="start">Sort by Start Date</option>
          <option value="status">Sort by Status</option>
          <option value="title">Sort by Title</option>
        </select>
        </label>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 mb-4 text-xs">
        {STATUS_ORDER.map((status) => {
          const c = STATUS_COLORS[status];
          return (
            <div key={status} className="flex items-center gap-1.5">
              <span
                className="inline-block w-3 h-3 rounded-sm"
                style={{ backgroundColor: c.bar }}
              />
              <span style={{ color: c.text }}>{status}</span>
            </div>
          );
        })}
      </div>

      {/* Chart Area */}
      <div className="overflow-x-auto" role="region" aria-label="Milestone Gantt Chart">
        <svg
          width="100%"
          height={CHART_HEIGHT}
          viewBox={`0 0 ${LABEL_WIDTH + 600} ${CHART_HEIGHT}`}
          className="min-w-[600px]"
          style={{ overflow: "visible" }}
        >
          {/* Grid lines */}
          {Array.from({ length: 6 }).map((_, i) => {
            const x = LABEL_WIDTH + (i / 5) * 600;
            const date = new Date(
              minDate.getTime() + (i / 5) * (maxDate.getTime() - minDate.getTime())
            );
            return (
              <g key={i}>
                <line
                  x1={x}
                  y1={HEADER_HEIGHT}
                  x2={x}
                  y2={CHART_HEIGHT - 10}
                  stroke="var(--border-color)"
                  strokeWidth="0.5"
                  strokeDasharray="4 4"
                />
                <text
                  x={x}
                  y={HEADER_HEIGHT - 8}
                  fill="var(--text-muted)"
                  fontSize="10"
                  textAnchor="middle"
                >
                  {date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </text>
              </g>
            );
          })}

          {/* Milestone bars */}
          {sorted.map((milestone, index) => {
            const y = HEADER_HEIGHT + index * ROW_HEIGHT + 10;
            const offsetPct = getBarOffset(milestone.startDate);
            const widthPct = getBarWidth(milestone.startDate, milestone.endDate);
            const barX = LABEL_WIDTH + (offsetPct / 100) * 600;
            const barW = Math.max(4, (widthPct / 100) * 600);
            const color = STATUS_COLORS[milestone.status];
            const barH = 28;
            const progressW = (milestone.progress / 100) * barW;

            return (
              <g
                key={milestone.id}
                onMouseEnter={(e) => handleMouseEnter(e, milestone)}
                onMouseMove={(e) => handleMouseEnter(e, milestone)}
                onMouseLeave={handleMouseLeave}
                style={{ cursor: "pointer" }}
              >
                {/* Label */}
                <text
                  x={LABEL_WIDTH - 8}
                  y={y + barH / 2 + 4}
                  fill="var(--text-primary)"
                  fontSize="11"
                  textAnchor="end"
                  className="select-none"
                >
                  {milestone.title}
                </text>

                {/* Bar background */}
                <rect
                  x={barX}
                  y={y}
                  width={barW}
                  height={barH}
                  rx="4"
                  fill={color.bg}
                  stroke={color.bar}
                  strokeWidth="1"
                  strokeOpacity="0.4"
                />

                {/* Progress fill */}
                <rect
                  x={barX}
                  y={y}
                  width={progressW}
                  height={barH}
                  rx="4"
                  fill={color.bar}
                  fillOpacity="0.7"
                >
                  <animate
                    attributeName="width"
                    from="0"
                    to={progressW}
                    dur="0.5s"
                    fill="freeze"
                  />
                </rect>

                {/* Status badge */}
                <text
                  x={barX + barW + 6}
                  y={y + barH / 2 + 4}
                  fill={color.text}
                  fontSize="9"
                  fontWeight="600"
                >
                  {milestone.status} {milestone.progress}%
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none bg-[var(--bg-card)] border border-[var(--border-color)] rounded-[var(--radius-md)] p-4 shadow-xl"
          style={{
            left: tooltip.x + 16,
            top: tooltip.y - 10,
            maxWidth: "280px",
          }}
        >
          <div className="flex items-center justify-between gap-3 mb-2">
            <span className="text-sm font-bold text-[var(--text-primary)]">
              {tooltip.milestone.title}
            </span>
            <span
              className="text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide"
              style={{
                color: STATUS_COLORS[tooltip.milestone.status].text,
                backgroundColor: STATUS_COLORS[tooltip.milestone.status].bg,
                border: `1px solid ${STATUS_COLORS[tooltip.milestone.status].bar}40`,
              }}
            >
              {tooltip.milestone.status}
            </span>
          </div>

          {tooltip.milestone.description && (
            <p className="text-xs text-[var(--text-secondary)] mb-2">
              {tooltip.milestone.description}
            </p>
          )}

          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <span className="text-[var(--text-muted)]">Start</span>
            <span className="text-[var(--text-primary)] text-right font-mono">
              {formatDate(tooltip.milestone.startDate)}
            </span>
            <span className="text-[var(--text-muted)]">End</span>
            <span className="text-[var(--text-primary)] text-right font-mono">
              {formatDate(tooltip.milestone.endDate)}
            </span>
            <span className="text-[var(--text-muted)]">Progress</span>
            <span className="text-[var(--text-primary)] text-right font-mono">
              {tooltip.milestone.progress}%
            </span>
          </div>

          <div className="mt-2 pt-2 border-t border-[var(--border-color)]">
            <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider block mb-1">
              Multisig Voting
            </span>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-emerald-400 font-semibold">
                {tooltip.milestone.votesFor} For
              </span>
              <span className="text-[var(--text-muted)]">/</span>
              <span className="text-red-400 font-semibold">
                {tooltip.milestone.votesAgainst} Against
              </span>
              <span className="text-[var(--text-muted)]">·</span>
              <span className="text-[var(--text-muted)]">
                {tooltip.milestone.votesTotal} total
              </span>
            </div>
            {tooltip.milestone.votesTotal > 0 && (
              <div className="mt-1 w-full h-1.5 bg-[var(--bg-primary)] rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${(tooltip.milestone.votesFor / tooltip.milestone.votesTotal) * 100}%`,
                    background: "linear-gradient(90deg, #10b981, #06b6d4)",
                  }}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export default MilestoneGanttChart;
