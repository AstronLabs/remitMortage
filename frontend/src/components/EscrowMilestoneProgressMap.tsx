"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import type { MilestoneNode, MilestoneState } from "./MilestoneTimeline";

/* ── Borrower-facing status (issue #821) ──────────────────────────────────
 * MilestoneTimeline's MilestoneState is a governance/voting vocabulary
 * (Proposed/Voting/Approved/Disbursed/Disputed). Borrowers think in terms of
 * pending / in-review / approved / disbursed, so this maps onto that without
 * changing the underlying data or MilestoneTimeline itself. A dispute is
 * mapped to "in-review" (it is, functionally, still awaiting resolution) but
 * keeps its own distinct color so it is never visually indistinguishable
 * from an ordinary in-review milestone.
 * ────────────────────────────────────────────────────────────────────── */

export type EscrowMilestoneStatus = "pending" | "in-review" | "approved" | "disbursed";

export interface EscrowMilestoneItem {
  id: string;
  title: string;
  status: EscrowMilestoneStatus;
  isDisputed: boolean;
}

const STATE_TO_STATUS: Record<MilestoneState, EscrowMilestoneStatus> = {
  Proposed: "pending",
  Voting: "in-review",
  Disputed: "in-review",
  Approved: "approved",
  Disbursed: "disbursed",
};

export function mapMilestoneStateToEscrowStatus(state: MilestoneState): EscrowMilestoneStatus {
  return STATE_TO_STATUS[state];
}

export function toEscrowMilestoneItems(milestones: readonly MilestoneNode[]): EscrowMilestoneItem[] {
  return milestones.map((m) => ({
    id: m.id,
    title: m.title,
    status: mapMilestoneStateToEscrowStatus(m.state),
    isDisputed: m.state === "Disputed",
  }));
}

const STATUS_LABEL: Record<EscrowMilestoneStatus, string> = {
  pending: "Pending",
  "in-review": "In Review",
  approved: "Approved",
  disbursed: "Disbursed",
};

// Matches MilestoneTimeline.tsx's STATE_STYLES palette so a milestone reads
// the same color across both components.
const STATUS_STYLE: Record<EscrowMilestoneStatus, { dot: string; text: string; ring: string }> = {
  pending: { dot: "bg-cyan-400", text: "text-cyan-300", ring: "ring-cyan-400/40" },
  "in-review": { dot: "bg-indigo-400", text: "text-indigo-300", ring: "ring-indigo-400/40" },
  approved: { dot: "bg-emerald-400", text: "text-emerald-300", ring: "ring-emerald-400/40" },
  disbursed: { dot: "bg-emerald-500", text: "text-emerald-300", ring: "ring-emerald-500/40" },
};
const DISPUTED_STYLE = { dot: "bg-rose-500", text: "text-rose-300", ring: "ring-rose-500/40" };

/**
 * The first not-yet-disbursed milestone in sequence — the borrower's next
 * actionable step. Returns -1 when every milestone is disbursed (nothing left
 * to act on) or the list is empty.
 */
export function findCurrentMilestoneIndex(items: readonly EscrowMilestoneItem[]): number {
  return items.findIndex((m) => m.status !== "disbursed");
}

/**
 * What fraction of the escrow target has actually been released, as a
 * percent in [0, 100]. Derived from the same deposited/target figures the
 * rest of the dashboard already shows — not re-derived from milestone count,
 * since milestones carry no dollar amount to weight by.
 */
export function computeEscrowRelease(deposited: string, target: string): number {
  const dep = Number(deposited);
  const tgt = Number(target);
  if (!Number.isFinite(dep) || !Number.isFinite(tgt) || tgt <= 0) return 0;
  return Math.min(100, Math.max(0, (dep / tgt) * 100));
}

export interface EscrowMilestoneProgressMapProps {
  milestones: readonly MilestoneNode[];
  escrow: { deposited: string; target: string };
}

/**
 * Horizontal visual timeline of loan milestones with a cumulative
 * escrow-release percentage overlaid on the connecting track, and the
 * current/next actionable milestone visually distinguished from completed
 * and future ones (issue #821).
 */
export function EscrowMilestoneProgressMap({ milestones, escrow }: EscrowMilestoneProgressMapProps) {
  const items = toEscrowMilestoneItems(milestones);
  const releasePct = computeEscrowRelease(escrow.deposited, escrow.target);
  const currentIndex = findCurrentMilestoneIndex(items);

  if (items.length === 0) return null;

  // Nodes are evenly spaced along the track — milestones carry no individual
  // dollar amount to weight positions by, only the overall release % does.
  const nodePct = (i: number) => (items.length === 1 ? 50 : (i / (items.length - 1)) * 100);

  return (
    <div data-testid="escrow-milestone-progress-map" className="w-full">
      <div className="mb-4 flex items-center justify-between text-xs">
        <span className="font-semibold text-slate-300">Escrow released</span>
        <span className="font-mono font-bold text-emerald-300" data-testid="escrow-release-percent">
          {releasePct.toFixed(0)}%
        </span>
      </div>

      <div className="overflow-x-auto">
      <div className="relative pt-2 pb-10" style={{ minWidth: Math.max(320, items.length * 140) }}>
        {/* Track: remaining (future) escrow */}
        <div className="absolute left-0 right-0 top-2 h-2 rounded-full bg-slate-800" aria-hidden="true" />
        {/* Track: cumulative released fill */}
        <div
          className="absolute left-0 top-2 h-2 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-[width]"
          style={{ width: `${releasePct}%` }}
          aria-hidden="true"
        />

        <ol className="relative">
          {items.map((item, i) => {
            const isCurrent = i === currentIndex;
            const style = item.isDisputed ? DISPUTED_STYLE : STATUS_STYLE[item.status];
            return (
              <li
                key={item.id}
                data-testid={`escrow-milestone-node-${item.id}`}
                data-status={item.status}
                data-current={isCurrent ? "true" : "false"}
                data-disputed={item.isDisputed ? "true" : "false"}
                className="flex flex-col items-center text-center"
                style={{ position: "absolute", left: `${nodePct(i)}%`, transform: "translateX(-50%)" }}
              >
                <span
                  className={`h-4 w-4 rounded-full border-2 border-slate-950 ${style.dot} ${
                    isCurrent ? `ring-4 ${style.ring} animate-pulse` : ""
                  }`}
                  aria-hidden="true"
                />
                <span className={`mt-3 max-w-[110px] text-[11px] font-semibold leading-snug ${isCurrent ? "text-white" : "text-slate-300"}`}>
                  {item.title}
                </span>
                <span
                  className={`mt-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${style.text} ${
                    isCurrent ? "bg-slate-800" : "bg-slate-900/60"
                  }`}
                >
                  {item.isDisputed ? "Disputed" : STATUS_LABEL[item.status]}
                  {isCurrent ? " · Next up" : ""}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      </div>
    </div>
  );
}

export default EscrowMilestoneProgressMap;
