"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useWallet } from "@/context/WalletContext";
import {
  fetchUpcomingOfferings,
  fetchWatchlist,
  unwatchOffering,
  watchOffering,
  type OfferingState,
  type UpcomingOffering,
  type WatchlistItem,
} from "@/lib/watchlistApi";

const STATE_LABEL: Record<OfferingState, string> = {
  upcoming: "Upcoming",
  open: "Open for investment",
  closed: "Closed",
};

const STATE_STYLE: Record<OfferingState, string> = {
  upcoming: "bg-slate-800 text-slate-300",
  open: "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30",
  closed: "bg-rose-500/10 text-rose-300 border border-rose-500/30",
};

function formatPrincipal(value: number): string {
  return `$${value.toLocaleString("en-US")}`;
}

function formatRate(bps: number): string {
  return `${(bps / 100).toFixed(2)}% APR`;
}

/**
 * Investor watchlist (issue #799): upcoming offerings that can be watched,
 * plus the investor's own watchlist as a view distinct from active holdings.
 * A watched offering's state flips to "Open for investment" once it opens,
 * and the backend sends an in-app notification at the same moment.
 */
export function InvestorWatchlist() {
  const { isConnected } = useWallet();
  const [upcoming, setUpcoming] = useState<UpcomingOffering[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [offerings, items] = await Promise.all([fetchUpcomingOfferings(), fetchWatchlist()]);
      setUpcoming(offerings);
      setWatchlist(items);
      setError(null);
    } catch {
      setError("Couldn't load your watchlist. Please try again shortly.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isConnected) void load();
  }, [isConnected, load]);

  async function toggle(loanId: string, currentlyWatched: boolean) {
    setBusyId(loanId);
    try {
      if (currentlyWatched) {
        await unwatchOffering(loanId);
      } else {
        await watchOffering(loanId);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update your watchlist.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="mb-10 mt-10" data-testid="investor-watchlist">
      <h2 className="mb-4 text-lg font-bold text-white">Watchlist</h2>

      {!isConnected ? (
        <p className="text-xs text-slate-500">Connect wallet to watch upcoming offerings.</p>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6">
            <h3 className="mb-1 text-sm font-bold text-white">Upcoming offerings</h3>
            <p className="mb-4 text-xs text-slate-500">
              Still in underwriting. Watch one to be notified when it opens for investment.
            </p>
            {loading && upcoming.length === 0 ? (
              <p className="text-xs text-slate-400">Loading…</p>
            ) : upcoming.length === 0 ? (
              <p className="text-xs text-slate-400">No upcoming offerings right now.</p>
            ) : (
              <ul className="space-y-2">
                {upcoming.map((offering) => (
                  <li
                    key={offering.id}
                    data-testid={`upcoming-offering-${offering.id}`}
                    className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3"
                  >
                    <div>
                      <p className="font-mono text-sm font-bold text-white">
                        {formatPrincipal(offering.principal)}
                      </p>
                      <p className="text-[11px] text-slate-400">
                        {formatRate(offering.interestRateBps)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void toggle(offering.id, offering.watched)}
                      disabled={busyId === offering.id}
                      aria-pressed={offering.watched}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:border-cyan-400 disabled:opacity-40"
                    >
                      {offering.watched ? (
                        <>
                          <EyeOff className="h-3.5 w-3.5" /> Unwatch
                        </>
                      ) : (
                        <>
                          <Eye className="h-3.5 w-3.5" /> Watch
                        </>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6">
            <h3 className="mb-1 text-sm font-bold text-white">My watchlist</h3>
            <p className="mb-4 text-xs text-slate-500">
              Offerings you&apos;re tracking — separate from your active holdings.
            </p>
            {watchlist.length === 0 ? (
              <p className="text-xs text-slate-400">You aren&apos;t watching any offerings yet.</p>
            ) : (
              <ul className="space-y-2">
                {watchlist.map((item) => (
                  <li
                    key={item.loanId}
                    data-testid={`watchlist-item-${item.loanId}`}
                    className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3"
                  >
                    <div>
                      <p className="font-mono text-sm font-bold text-white">
                        {formatPrincipal(item.principal)}
                      </p>
                      <p className="text-[11px] text-slate-400">{formatRate(item.interestRateBps)}</p>
                      <span
                        className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${STATE_STYLE[item.state]}`}
                      >
                        {STATE_LABEL[item.state]}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void toggle(item.loanId, true)}
                      disabled={busyId === item.loanId}
                      className="text-xs font-semibold text-slate-400 transition-colors hover:text-rose-300 disabled:opacity-40"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-xs text-rose-400">{error}</p>}
    </section>
  );
}

export default InvestorWatchlist;
