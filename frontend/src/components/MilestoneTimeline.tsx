"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState } from "react";
import type { EvidenceRevision } from "../lib/milestoneRevisionsStore";
import EvidenceDiffViewer from "./governance/EvidenceDiffViewer";

/* ── Types ─────────────────────────────────────────────────────────── */

export type MilestoneState = "Proposed" | "Voting" | "Approved" | "Disbursed" | "Disputed";

export interface VoterRecord {
  address: string;
  vote: "yes" | "no" | "abstain";
  weight: number;
}

export interface EvidenceItem {
  label: string;
  url: string;
}

export interface MilestoneNode {
  id: string;
  title: string;
  state: MilestoneState;
  scheduledDate: string;
  completedDate?: string;
  description?: string;
  evidence?: EvidenceItem[];
  revisions?: EvidenceRevision[];
  voters?: VoterRecord[];
}

/* ── Theme config per state ────────────────────────────────────────── */

type StateStyle = {
  color: string;
  bg: string;
  border: string;
  icon: React.ReactNode;
};

const STATE_STYLES: Record<MilestoneState, StateStyle> = {
  Proposed: {
    color: "var(--accent-secondary)",
    bg: "rgba(6, 182, 212, 0.12)",
    border: "rgba(6, 182, 212, 0.3)",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4"
      >
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
      </svg>
    ),
  },
  Voting: {
    color: "var(--accent-primary-light)",
    bg: "rgba(99, 102, 241, 0.12)",
    border: "rgba(99, 102, 241, 0.3)",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4"
      >
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
      </svg>
    ),
  },
  Approved: {
    color: "var(--success)",
    bg: "rgba(16, 185, 129, 0.12)",
    border: "rgba(16, 185, 129, 0.3)",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4"
      >
        <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </svg>
    ),
  },
  Disbursed: {
    color: "var(--success)",
    bg: "rgba(16, 185, 129, 0.18)",
    border: "rgba(16, 185, 129, 0.35)",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M16 8h-6a2 2 0 100 4h4a2 2 0 110 4H8" />
        <path d="M12 18V6" />
      </svg>
    ),
  },
  Disputed: {
    color: "var(--error)",
    bg: "rgba(239, 68, 68, 0.12)",
    border: "rgba(239, 68, 68, 0.3)",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
      </svg>
    ),
  },
};

/* ── Sub-components ────────────────────────────────────────────────── */

function VoterTable({ voters }: { voters: VoterRecord[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[var(--border-color)]">
            <th className="pb-2 pr-4 text-left font-semibold text-[var(--text-secondary)]">
              Voter
            </th>
            <th className="pb-2 pr-4 text-left font-semibold text-[var(--text-secondary)]">Vote</th>
            <th className="pb-2 text-right font-semibold text-[var(--text-secondary)]">Weight</th>
          </tr>
        </thead>
        <tbody>
          {voters.map((v, i) => (
            <tr key={i} className="border-b border-[var(--border-color)] last:border-0">
              <td className="py-1.5 pr-4 font-mono text-[var(--text-muted)]">
                {shortAddr(v.address)}
              </td>
              <td className="py-1.5 pr-4">
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold
                    ${
                      v.vote === "yes"
                        ? "bg-emerald-500/15 text-emerald-400"
                        : v.vote === "no"
                          ? "bg-red-500/15 text-red-400"
                          : "bg-[var(--text-muted)]/10 text-[var(--text-muted)]"
                    }`}
                >
                  {v.vote === "yes" && (
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      className="h-3 w-3"
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                  {v.vote === "no" && (
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      className="h-3 w-3"
                    >
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  )}
                  {v.vote === "abstain" && "—"}
                  {v.vote}
                </span>
              </td>
              <td className="py-1.5 text-right text-[var(--text-secondary)]">{v.weight}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

/* ── Timeline Node ─────────────────────────────────────────────────── */

function TimelineNode({ milestone, isLast }: { milestone: MilestoneNode; isLast: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const style = STATE_STYLES[milestone.state];

  const revisions: EvidenceRevision[] | null = (() => {
    if (milestone.revisions && milestone.revisions.length > 0) return milestone.revisions;
    if (milestone.evidence && milestone.evidence.length > 1) {
      return milestone.evidence.map((ev, idx) => ({
        id: `${milestone.id}-ev-${idx}`,
        cid: ev.url.replace("ipfs://", ""),
        url: ev.url,
        label: ev.label,
        sha256: undefined,
        description: idx === 0 ? milestone.description : `${milestone.description ?? ""} (rev ${idx + 1})`,
        costEstimate: undefined,
        uploadedAt: new Date(Date.now() - (milestone.evidence!.length - idx) * 86400000).toISOString(),
        version: idx + 1,
      }));
    }
    return null;
  })();

  return (
    <li className="relative flex gap-4 md:gap-6">
      {/* Vertical connector line */}
      {!isLast && (
        <div
          className="absolute left-[15px] md:left-[19px] top-[36px] bottom-0 w-0.5 bg-[var(--border-color)]"
          aria-hidden="true"
        />
      )}

      {/* Node circle */}
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label={`${milestone.title} — ${milestone.state}`}
        className="relative z-10 mt-1 flex h-8 w-8 md:h-10 md:w-10 shrink-0 items-center justify-center rounded-full border-2 transition-all hover:scale-110 focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
        style={{
          backgroundColor: style.bg,
          borderColor: style.border,
          color: style.color,
        }}
      >
        {style.icon}
      </button>

      {/* Card */}
      <div className="min-w-0 flex-1 pb-6">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full text-left"
          aria-expanded={expanded}
        >
          <div
            className="rounded-[var(--radius-md)] border p-4 transition-all hover:shadow-[var(--shadow-glow)]"
            style={{ borderColor: style.border, backgroundColor: style.bg }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                {milestone.title}
              </h3>
              <span
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                style={{ color: style.color, border: `1px solid ${style.border}` }}
              >
                {milestone.state}
              </span>
            </div>

            {milestone.description && (
              <p className="mt-1 text-xs text-[var(--text-secondary)]">{milestone.description}</p>
            )}

            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--text-muted)]">
              <span>Scheduled: {milestone.scheduledDate}</span>
              {milestone.completedDate && <span>Completed: {milestone.completedDate}</span>}
            </div>
          </div>
        </button>

        {/* Expanded details pane */}
        {expanded && (
          <div
            className="mt-3 rounded-[var(--radius-md)] border border-[var(--border-color)] bg-[var(--bg-card)] p-4 animate-fade-in-up"
            role="region"
            aria-label={`Details for ${milestone.title}`}
          >
            {/* Evidence URLs */}
            {milestone.evidence && milestone.evidence.length > 0 && (
              <div className="mb-4">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                    Evidence
                  </h4>
                  {revisions && revisions.length > 1 && (
                    <button
                      onClick={() => setDiffOpen(true)}
                      className="inline-flex items-center gap-1 rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-cyan-400 hover:bg-cyan-500/20"
                    >
                      View History Diff ({revisions.length})
                    </button>
                  )}
                </div>
                <ul className="space-y-1.5">
                  {milestone.evidence.map((ev, i) => (
                    <li key={i}>
                      <a
                        href={ev.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs text-[var(--accent-primary-light)] hover:underline"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="h-3.5 w-3.5"
                        >
                          <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                          <polyline points="15 3 21 3 21 9" />
                          <line x1="10" y1="14" x2="21" y2="3" />
                        </svg>
                        {ev.label}
                      </a>
                    </li>
                  ))}
                </ul>
                {revisions && revisions.length > 1 && diffOpen && (
                  <EvidenceDiffViewer milestoneId={milestone.id} revisions={revisions} onClose={() => setDiffOpen(false)} />
                )}
              </div>
            )}
            {milestone.revisions && milestone.revisions.length > 0 && !milestone.evidence?.length && (
              <div className="mb-4">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                    Evidence Revisions
                  </h4>
                  <button
                    onClick={() => setDiffOpen(true)}
                    className="inline-flex items-center gap-1 rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-cyan-400 hover:bg-cyan-500/20"
                  >
                    Diff Viewer ({milestone.revisions!.length})
                  </button>
                </div>
                <ul className="space-y-1">
                  {milestone.revisions.map((r) => (
                    <li key={r.id} className="text-xs text-slate-300">
                      v{r.version} — {r.label} <span className="text-slate-500">({new Date(r.uploadedAt).toLocaleDateString()})</span>
                    </li>
                  ))}
                </ul>
                {diffOpen && <EvidenceDiffViewer milestoneId={milestone.id} revisions={milestone.revisions!} onClose={() => setDiffOpen(false)} />}
              </div>
            )}

            {/* Voter distribution */}
            {milestone.voters && milestone.voters.length > 0 && (
              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                  Voter Distribution
                </h4>
                <VoterTable voters={milestone.voters} />
              </div>
            )}

            {!milestone.evidence?.length && !milestone.voters?.length && (
              <p className="text-xs text-[var(--text-muted)]">
                No additional details available for this milestone.
              </p>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/* ── Timeline Root ─────────────────────────────────────────────────── */

export interface MilestoneTimelineProps {
  milestones: MilestoneNode[];
  /** Optional title rendered above the timeline. */
  title?: string;
}

/**
 * Responsive vertical milestone timeline.
 * - Mobile: single-column vertical stack
 * - Desktop: wider cards with SVG-accented connector line
 * - Click any node to expand evidence links + voter table
 */
export function MilestoneTimeline({ milestones, title }: MilestoneTimelineProps) {
  if (!milestones.length) return null;

  return (
    <section className="w-full rounded-[var(--radius-lg)] border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 md:p-6">
      {title && <h2 className="mb-4 text-lg font-bold text-[var(--text-primary)]">{title}</h2>}

      <ol className="relative" aria-label="Milestone timeline">
        {milestones.map((m, i) => (
          <TimelineNode key={m.id} milestone={m} isLast={i === milestones.length - 1} />
        ))}
      </ol>
    </section>
  );
}

export default MilestoneTimeline;
