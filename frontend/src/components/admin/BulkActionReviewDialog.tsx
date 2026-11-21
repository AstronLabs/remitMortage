"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useId, useMemo, useState } from "react";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";

/** One row that a bulk action is about to touch. */
export interface BulkReviewRow {
  id: string;
  /** Primary text shown for the row, e.g. the borrower address. */
  label: string;
  /** Secondary text, e.g. the principal and current status. */
  detail?: string;
}

/** The exact change a bulk action applies to every included row. */
export interface BulkReviewChange {
  field: string;
  from?: string;
  to: string;
}

interface BulkActionReviewDialogProps {
  title: string;
  change: BulkReviewChange;
  rows: BulkReviewRow[];
  confirmLabel: string;
  confirmationText?: string;
  destructive?: boolean;
  /** Above this many rows only a sample is rendered, with a summary count. */
  sampleThreshold?: number;
  /** How many rows the sample (and a search) renders for a large selection. */
  sampleSize?: number;
  /** Receives only the rows still included when the admin confirms. */
  onConfirm: (includedIds: string[]) => void | Promise<void>;
  onCancel: () => void;
}

export const DEFAULT_SAMPLE_THRESHOLD = 50;
export const DEFAULT_SAMPLE_SIZE = 20;

/**
 * Review step shown before a bulk action takes effect (issue #1109). Lists
 * every affected row and the exact change, lets the admin exclude individual
 * rows, and for very large selections renders a summary count with a sample
 * plus a search so any row can still be found and excluded.
 */
export function BulkActionReviewDialog({
  title,
  change,
  rows,
  confirmLabel,
  confirmationText,
  destructive = true,
  sampleThreshold = DEFAULT_SAMPLE_THRESHOLD,
  sampleSize = DEFAULT_SAMPLE_SIZE,
  onConfirm,
  onCancel,
}: BulkActionReviewDialogProps) {
  const id = useId();
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");

  const isLarge = rows.length > sampleThreshold;
  const includedIds = useMemo(
    () => rows.filter((row) => !excluded.has(row.id)).map((row) => row.id),
    [rows, excluded]
  );

  const visibleRows = useMemo(() => {
    if (!isLarge) return rows;
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? rows.filter(
          (row) =>
            row.id.toLowerCase().includes(needle) ||
            row.label.toLowerCase().includes(needle) ||
            row.detail?.toLowerCase().includes(needle)
        )
      : rows;
    return matches.slice(0, sampleSize);
  }, [isLarge, query, rows, sampleSize]);

  const toggle = (rowId: string) =>
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });

  const changeText = change.from
    ? `${change.field}: ${change.from} → ${change.to}`
    : `${change.field} → ${change.to}`;
  const hiddenCount = rows.length - visibleRows.length;

  return (
    <ConfirmationDialog
      isOpen
      title={title}
      description={
        <span data-testid="bulk-review-summary">
          <strong>{includedIds.length}</strong> of {rows.length} selected row
          {rows.length === 1 ? "" : "s"} will change.
          {excluded.size > 0 && ` ${excluded.size} excluded.`}
        </span>
      }
      confirmLabel={`${confirmLabel} (${includedIds.length})`}
      confirmationText={confirmationText}
      destructive={destructive}
      confirmDisabled={includedIds.length === 0}
      onConfirm={() => onConfirm(includedIds)}
      onCancel={onCancel}
    >
      <p
        data-testid="bulk-review-change"
        className="mt-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-3 py-2 text-sm font-medium text-[var(--text-primary)]"
      >
        Change: {changeText}
      </p>

      {isLarge && (
        <div className="mt-3">
          <label
            htmlFor={`${id}-search`}
            className="mb-1 block text-xs text-[var(--text-secondary)]"
          >
            Showing a sample of {Math.min(sampleSize, rows.length)}. Search all {rows.length} rows
            to exclude one.
          </label>
          <input
            id={`${id}-search`}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by ID or borrower"
            className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-3 py-1.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
          />
        </div>
      )}

      <ul
        aria-label="Rows affected by this action"
        data-testid="bulk-review-rows"
        className="mt-3 max-h-64 space-y-1.5 overflow-y-auto pr-1"
      >
        {visibleRows.map((row) => {
          const included = !excluded.has(row.id);
          return (
            <li
              key={row.id}
              className={`flex items-start gap-3 rounded-lg border border-[var(--border-color)] px-3 py-2 text-xs ${
                included ? "" : "opacity-50"
              }`}
            >
              <input
                id={`${id}-${row.id}`}
                type="checkbox"
                checked={included}
                onChange={() => toggle(row.id)}
                aria-label={`Include ${row.label}`}
                className="mt-0.5 h-4 w-4 accent-sky-500"
              />
              <label htmlFor={`${id}-${row.id}`} className="flex-1 cursor-pointer">
                <span
                  className={`block font-mono text-[var(--text-primary)] ${included ? "" : "line-through"}`}
                >
                  {row.label}
                </span>
                {row.detail && <span className="block text-[var(--text-muted)]">{row.detail}</span>}
              </label>
            </li>
          );
        })}
      </ul>

      {isLarge && hiddenCount > 0 && (
        <p data-testid="bulk-review-hidden-count" className="mt-2 text-xs text-[var(--text-muted)]">
          …and {hiddenCount} more row{hiddenCount === 1 ? "" : "s"} not shown.
        </p>
      )}

      {excluded.size > 0 && (
        <button
          type="button"
          onClick={() => setExcluded(new Set())}
          className="mt-2 text-xs font-medium text-sky-400 hover:text-sky-300"
        >
          Include all {rows.length} again
        </button>
      )}
    </ConfirmationDialog>
  );
}

export default BulkActionReviewDialog;
