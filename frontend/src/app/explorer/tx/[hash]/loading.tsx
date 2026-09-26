// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

export default function ExplorerTransactionLoading() {
  return (
    <div
      data-testid="explorer-tx-skeleton"
      className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-6 sm:p-8 animate-pulse"
    >
      <div className="flex items-start justify-between gap-3 mb-6">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="h-3 w-24 rounded bg-[var(--border-color)]" />
          <div className="h-5 w-3/4 rounded bg-[var(--border-color)]" />
        </div>
        <div className="h-6 w-20 shrink-0 rounded-full bg-[var(--border-color)]" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <div className="h-3 w-20 rounded bg-[var(--border-color)]" />
            <div className="h-4 w-32 rounded bg-[var(--border-color)]" />
          </div>
        ))}
      </div>
    </div>
  );
}
