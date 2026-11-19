"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Fuel, Info, KeyRound, ShieldCheck, XCircle } from "lucide-react";
import type { PreviewEffectKind, TransactionPreview } from "../../lib/transaction-preview";

const EFFECT_ICONS: Record<PreviewEffectKind, typeof ArrowUpRight> = {
  debit: ArrowUpRight,
  credit: ArrowDownLeft,
  fee: Fuel,
  authorization: ShieldCheck,
  account_policy: KeyRound,
  contract_call: Info,
};

const SEVERITY_STYLES = {
  info: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  danger: "border-red-500/30 bg-red-500/10 text-red-300",
} as const;

interface Props {
  /** Null while the simulation is still in flight. */
  preview: TransactionPreview | null;
  loading?: boolean;
  /** Set when the user has ticked the acknowledgement box. */
  acknowledged?: boolean;
  onAcknowledgedChange?: (acknowledged: boolean) => void;
}

/**
 * Shows, in plain language, what a transaction will do — before the wallet
 * prompt opens (issue #884).
 *
 * Three states, each visually distinct because they mean different things:
 *
 * - **loading** — the simulation is in flight; no claims are made yet.
 * - **blocked** (`preview.ok === false`) — the simulation failed, so there is
 *   nothing trustworthy to show and signing is not offered at all.
 * - **ready** — the effects, plus any warnings. A `danger` warning requires
 *   the acknowledgement checkbox before the caller enables its sign button.
 */
export default function TransactionPreviewPanel({
  preview,
  loading = false,
  acknowledged = false,
  onAcknowledgedChange,
}: Props) {
  if (loading || !preview) {
    return (
      <div
        className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4"
        aria-busy="true"
      >
        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Checking what this will do
        </p>
        <p className="mt-2 text-sm text-[var(--text-muted)]">
          Simulating the transaction against the network…
        </p>
      </div>
    );
  }

  if (!preview.ok) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-red-500/30 bg-red-500/10 p-4"
        data-testid="transaction-preview-blocked"
      >
        <p className="flex items-center gap-2 text-sm font-semibold text-red-300">
          <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          This transaction was not sent to your wallet
        </p>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">{preview.failureReason}</p>
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          Nothing was signed and no fee was charged.
        </p>
      </div>
    );
  }

  const dangers = preview.warnings.filter((warning) => warning.severity === "danger");

  return (
    <div
      className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] overflow-hidden"
      data-testid="transaction-preview"
    >
      <div className="border-b border-[var(--border-color)] px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Before you sign
        </p>
        <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">{preview.summary}</p>
      </div>

      <ul className="divide-y divide-[var(--border-color)]/50">
        {preview.effects.map((effect, index) => {
          const Icon = EFFECT_ICONS[effect.kind];
          return (
            <li
              key={`${effect.kind}-${index}`}
              className="flex items-start gap-3 px-4 py-2.5 text-sm text-[var(--text-secondary)]"
            >
              <Icon
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]"
                aria-hidden="true"
              />
              <span>{effect.text}</span>
            </li>
          );
        })}
      </ul>

      {preview.warnings.length > 0 && (
        <div className="space-y-2 border-t border-[var(--border-color)] p-4">
          {preview.warnings.map((warning) => (
            <p
              key={warning.code}
              role={warning.severity === "danger" ? "alert" : undefined}
              className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
                SEVERITY_STYLES[warning.severity]
              }`}
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{warning.text}</span>
            </p>
          ))}
        </div>
      )}

      {dangers.length > 0 && onAcknowledgedChange && (
        <label className="flex items-start gap-2.5 border-t border-[var(--border-color)] bg-red-500/5 p-4 text-xs text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => onAcknowledgedChange(event.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent-primary)]"
          />
          <span>
            I have read the {dangers.length === 1 ? "warning" : `${dangers.length} warnings`} above
            and want to sign this transaction anyway.
          </span>
        </label>
      )}
    </div>
  );
}
