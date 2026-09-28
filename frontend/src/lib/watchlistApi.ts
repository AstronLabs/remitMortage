// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type OfferingState = "upcoming" | "open" | "closed";

export interface UpcomingOffering {
  id: string;
  principal: number;
  interestRateBps: number;
  createdAt: string;
  watched: boolean;
}

export interface WatchlistItem {
  loanId: string;
  principal: number;
  interestRateBps: number;
  state: OfferingState;
  watchedSince: string;
  notifiedAt: string | null;
}

export async function fetchUpcomingOfferings(): Promise<UpcomingOffering[]> {
  const res = await fetch(`${API_BASE}/api/watchlist/upcoming`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load upcoming offerings");
  return (await res.json()).offerings;
}

export async function fetchWatchlist(): Promise<WatchlistItem[]> {
  const res = await fetch(`${API_BASE}/api/watchlist`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load watchlist");
  return (await res.json()).watchlist;
}

export async function watchOffering(loanId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/watchlist/${encodeURIComponent(loanId)}`, {
    method: "PUT",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? "Failed to watch offering");
  }
}

export async function unwatchOffering(loanId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/watchlist/${encodeURIComponent(loanId)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to remove offering from watchlist");
}
