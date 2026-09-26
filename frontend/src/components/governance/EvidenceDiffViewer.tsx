"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useMemo, useState } from "react";
import { IPFSMediaPlayer } from "../IPFSMediaPlayer";
import type { EvidenceRevision } from "../../lib/milestoneRevisionsStore";

export interface EvidenceDiffViewerProps {
  milestoneId: string;
  revisions: EvidenceRevision[];
  initialA?: number;
  initialB?: number;
  onClose?: () => void;
}

function getChangedFields(a: EvidenceRevision, b: EvidenceRevision): Set<string> {
  const changed = new Set<string>();
  if ((a.description ?? "") !== (b.description ?? "")) changed.add("description");
  if ((a.costEstimate ?? null) !== (b.costEstimate ?? null)) changed.add("costEstimate");
  if (a.cid !== b.cid) changed.add("cid");
  if ((a.sha256 ?? "") !== (b.sha256 ?? "")) changed.add("sha256");
  if ((a.label ?? "") !== (b.label ?? "")) changed.add("label");
  return changed;
}

function MetaRow({ label, value, changed }: { label: string; value: React.ReactNode; changed?: boolean }) {
  return (
    <div
      className={`flex justify-between gap-4 rounded-lg px-3 py-2 text-xs ${changed ? "bg-amber-500/10 ring-1 ring-amber-400/40" : "bg-slate-800/40"}`}
    >
      <span className="font-semibold text-[var(--text-secondary)]">{label}</span>
      <span className={`text-right ${changed ? "text-amber-300 font-semibold" : "text-slate-200"}`}>{value ?? "—"}</span>
    </div>
  );
}

function RevisionPane({ rev, changedFields, side }: { rev: EvidenceRevision; changedFields: Set<string>; side: "prev" | "current" }) {
  return (
    <div className="flex flex-1 flex-col gap-3 rounded-xl border border-slate-700 bg-slate-900/60 p-4">
      <div className="flex items-center justify-between">
        <span className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${side === "prev" ? "bg-slate-700 text-slate-300" : "bg-cyan-500/15 text-cyan-400 border border-cyan-500/20"}`}>
          {side === "prev" ? `v${rev.version} Previous` : `v${rev.version} Current`}
        </span>
        <span className="text-[11px] text-slate-400">{new Date(rev.uploadedAt).toLocaleString()}</span>
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-700 bg-black">
        <IPFSMediaPlayer cid={rev.cid} />
      </div>

      <div className="space-y-1.5">
        <MetaRow label="Label" value={rev.label} changed={changedFields.has("label")} />
        <MetaRow label="CID" value={<span className="font-mono text-[11px] break-all">{rev.cid}</span>} changed={changedFields.has("cid")} />
        <MetaRow label="SHA-256" value={<span className="font-mono text-[11px] break-all">{rev.sha256 ?? "—"}</span>} changed={changedFields.has("sha256")} />
        <MetaRow label="Description" value={rev.description ?? "—"} changed={changedFields.has("description")} />
        <MetaRow label="Cost estimate" value={rev.costEstimate != null ? `$${rev.costEstimate.toLocaleString()}` : "—"} changed={changedFields.has("costEstimate")} />
        <MetaRow label="Uploader" value={rev.uploader ?? "—"} />
        <a href={rev.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex text-xs font-semibold text-cyan-400 hover:underline">
          View on IPFS →
        </a>
      </div>
    </div>
  );
}

export default function EvidenceDiffViewer({ revisions, initialA, initialB, onClose }: EvidenceDiffViewerProps) {
  const count = revisions.length;

  const [indexA, setIndexA] = useState(() => {
    if (typeof initialA === "number") return initialA;
    return Math.max(0, count - 2);
  });
  const [indexB, setIndexB] = useState(() => {
    if (typeof initialB === "number") return initialB;
    return Math.max(0, count - 1);
  });

  const sorted = useMemo(() => [...revisions].sort((a, b) => a.version - b.version), [revisions]);
  const a = sorted[indexA];
  const b = sorted[indexB];
  const changedFields = useMemo(() => (a && b ? getChangedFields(a, b) : new Set<string>()), [a, b]);

  if (count < 2) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" role="dialog" aria-modal="true">
        <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-6">
          <h3 className="text-sm font-bold text-white">Not enough revisions</h3>
          <p className="mt-1 text-xs text-slate-400">Need at least two submissions to compare. Current: {count}.</p>
          {onClose && (
            <button onClick={onClose} className="mt-4 rounded-lg bg-slate-800 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-700">
              Close
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!a || !b) return null;

  const canPrevA = indexA > 0;
  const canNextA = indexA < count - 1 && indexA + 1 < indexB;
  const canPrevB = indexB > 0 && indexB - 1 > indexA;
  const canNextB = indexB < count - 1;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/70 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Evidence diff viewer">
      <div className="flex items-center justify-between border-b border-slate-700 bg-slate-900 px-4 py-3 md:px-6">
        <div>
          <h2 className="text-sm font-bold text-white">Evidence Revision Diff</h2>
          <p className="text-xs text-slate-400">
            Comparing v{a.version} → v{b.version} • {changedFields.size} changed field{changedFields.size !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden md:flex items-center gap-2 text-xs">
            <label className="text-slate-400">A</label>
            <select
              value={indexA}
              onChange={(e) => setIndexA(Number(e.target.value))}
              className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-white"
              aria-label="Select previous revision"
            >
              {sorted.map((r, i) => (
                <option key={r.id} value={i} disabled={i >= indexB}>
                  v{r.version} {new Date(r.uploadedAt).toLocaleDateString()}
                </option>
              ))}
            </select>
            <span className="text-slate-500">→</span>
            <label className="text-slate-400">B</label>
            <select
              value={indexB}
              onChange={(e) => setIndexB(Number(e.target.value))}
              className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-white"
              aria-label="Select current revision"
            >
              {sorted.map((r, i) => (
                <option key={r.id} value={i} disabled={i <= indexA}>
                  v{r.version} {new Date(r.uploadedAt).toLocaleDateString()}
                </option>
              ))}
            </select>
          </div>
          {onClose && (
            <button onClick={onClose} aria-label="Close diff viewer" className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700">
              Close
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col overflow-auto p-4 md:p-6">
        {changedFields.size > 0 && (
          <div className="mb-4 flex flex-wrap gap-1.5">
            {Array.from(changedFields).map((f) => (
              <span key={f} className="inline-flex rounded-full bg-amber-500/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-300 ring-1 ring-amber-400/30">
                {f} changed
              </span>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-4 md:flex-row md:items-stretch">
          <RevisionPane rev={a} changedFields={changedFields} side="prev" />
          <div className="hidden md:flex items-center justify-center">
            <span className="rounded-full bg-slate-800 p-2 text-slate-400">→</span>
          </div>
          <RevisionPane rev={b} changedFields={changedFields} side="current" />
        </div>

        <div className="mt-6 flex items-center justify-between border-t border-slate-800 pt-4">
          <div className="flex gap-2">
            <button
              disabled={!canPrevA && !canPrevB}
              onClick={() => {
                if (canPrevA) setIndexA((v) => v - 1);
                else if (canPrevB) setIndexB((v) => v - 1);
              }}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-40"
            >
              ← Prev step
            </button>
            <button
              disabled={!canNextA && !canNextB}
              onClick={() => {
                if (canNextB) setIndexB((v) => v + 1);
                else if (canNextA) setIndexA((v) => v + 1);
              }}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-40"
            >
              Next step →
            </button>
          </div>
          <span className="text-xs text-slate-400">
            Step {indexA + 1} → {indexB + 1} of {count} revisions
          </span>
        </div>

        <div className="mt-2 flex gap-2 md:hidden">
          <select value={indexA} onChange={(e) => setIndexA(Number(e.target.value))} className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-2 py-2 text-xs text-white">
            {sorted.map((r, i) => (
              <option key={r.id} value={i} disabled={i >= indexB}>
                v{r.version}
              </option>
            ))}
          </select>
          <select value={indexB} onChange={(e) => setIndexB(Number(e.target.value))} className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-2 py-2 text-xs text-white">
            {sorted.map((r, i) => (
              <option key={r.id} value={i} disabled={i <= indexA}>
                v{r.version}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
