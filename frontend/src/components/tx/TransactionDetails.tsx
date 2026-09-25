"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import type { TransactionType } from "../../lib/transaction-status";
import { shortenAddress } from "../../lib/transaction-status";

interface TransactionDetailsProps {
  hash: string;
  type: TransactionType;
  senderAddress: string | null;
  senderOverride?: string | null;
  gasFee: string | null;
  logs: Record<string, unknown>;
}

export default function TransactionDetails({
  hash,
  type,
  senderAddress,
  senderOverride,
  gasFee,
  logs,
}: TransactionDetailsProps) {
  const sender = senderOverride || senderAddress;

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-[var(--border-color)]">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Transaction Details
        </h2>
      </div>

      <dl className="divide-y divide-[var(--border-color)]/50">
        <DetailRow label="Type" value={type} />
        <DetailRow label="Hash" value={hash} mono />
        <DetailRow
          label="Sender"
          value={sender ? shortenAddress(sender) : "Pending…"}
          title={sender ?? undefined}
          mono
        />
        <DetailRow label="Gas Fee" value={gasFee ?? "Pending…"} />
      </dl>

      <div className="px-5 py-4 border-t border-[var(--border-color)]">
        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
          Raw JSON Logs
        </p>
        <pre className="text-xs font-mono text-[var(--text-secondary)] bg-[var(--bg-secondary)] rounded-lg p-4 overflow-x-auto max-h-64 overflow-y-auto">
          {JSON.stringify(logs, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3.5">
      <dt className="text-sm text-[var(--text-muted)] shrink-0">{label}</dt>
      <dd
        className={`text-sm text-[var(--text-primary)] text-right break-all ${
          mono ? "font-mono text-xs" : "font-medium"
        }`}
        title={title}
      >
        {value}
      </dd>
    </div>
  );
}
