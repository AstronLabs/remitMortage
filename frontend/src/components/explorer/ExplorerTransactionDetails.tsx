// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

export interface ExplorerTransactionRecord {
  hash: string;
  ledger: number;
  createdAt: string;
  sourceAccount: string;
  feeCharged: string;
  operationCount: number;
  memo?: string;
  successful: boolean;
}

function shortAddress(address: string): string {
  if (!address) return "—";
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

export default function ExplorerTransactionDetails({
  transaction,
}: {
  transaction: ExplorerTransactionRecord;
}) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-6 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-[var(--text-muted)] mb-1">
            Transaction
          </p>
          <h1 className="text-lg sm:text-xl font-bold text-[var(--text-primary)] break-all">
            {transaction.hash}
          </h1>
        </div>
        <span
          className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
            transaction.successful
              ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
              : "bg-red-500/15 text-red-400 border border-red-500/30"
          }`}
        >
          {transaction.successful ? "Successful" : "Failed"}
        </span>
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <dt className="text-xs uppercase tracking-wider text-[var(--text-muted)] mb-1">Ledger</dt>
          <dd className="text-sm font-semibold text-[var(--text-primary)]">{transaction.ledger}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wider text-[var(--text-muted)] mb-1">
            Created At
          </dt>
          <dd className="text-sm font-semibold text-[var(--text-primary)]">
            {new Date(transaction.createdAt).toLocaleString()}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wider text-[var(--text-muted)] mb-1">
            Source Account
          </dt>
          <dd className="text-sm font-semibold text-[var(--text-primary)] font-mono">
            {shortAddress(transaction.sourceAccount)}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wider text-[var(--text-muted)] mb-1">
            Fee Charged
          </dt>
          <dd className="text-sm font-semibold text-[var(--text-primary)]">
            {transaction.feeCharged} stroops
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wider text-[var(--text-muted)] mb-1">
            Operations
          </dt>
          <dd className="text-sm font-semibold text-[var(--text-primary)]">
            {transaction.operationCount}
          </dd>
        </div>
        {transaction.memo && (
          <div>
            <dt className="text-xs uppercase tracking-wider text-[var(--text-muted)] mb-1">Memo</dt>
            <dd className="text-sm font-semibold text-[var(--text-primary)] break-all">
              {transaction.memo}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
