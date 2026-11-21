"use client";

import { formatUpdatedAt, isStale } from "../../lib/dataFreshness";

export default function DataFreshness({
  timestamp,
  staleAfterMs,
  onRefresh,
  refreshing = false,
  refreshError,
}: {
  timestamp: string;
  staleAfterMs: number;
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshError?: string | null;
}) {
  const stale = isStale(timestamp, staleAfterMs);
  return (
    <div
      className={`mt-3 flex flex-wrap items-center gap-2 text-xs ${stale ? "text-amber-300" : "text-slate-400"}`}
    >
      <span role={stale ? "alert" : undefined}>
        {stale ? "Stale data · " : ""}
        {formatUpdatedAt(timestamp)}
      </span>
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="rounded border border-slate-700 px-2 py-1 hover:border-cyan-400 disabled:cursor-wait disabled:opacity-60"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      )}
      {refreshError && <span className="text-red-300">Refresh failed: {refreshError}</span>}
    </div>
  );
}
