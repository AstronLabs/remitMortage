// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import InvestorWatchlist from "../InvestorWatchlist";

let mockIsConnected = true;
jest.mock("@/context/WalletContext", () => ({
  useWallet: () => ({ publicKey: "GINVESTOR", isConnected: mockIsConnected }),
}));

const fetchUpcomingOfferingsMock = jest.fn();
const fetchWatchlistMock = jest.fn();
const watchOfferingMock = jest.fn();
const unwatchOfferingMock = jest.fn();

jest.mock("@/lib/watchlistApi", () => ({
  fetchUpcomingOfferings: (...args: unknown[]) => fetchUpcomingOfferingsMock(...args),
  fetchWatchlist: (...args: unknown[]) => fetchWatchlistMock(...args),
  watchOffering: (...args: unknown[]) => watchOfferingMock(...args),
  unwatchOffering: (...args: unknown[]) => unwatchOfferingMock(...args),
}));

const UPCOMING = [
  { id: "loan-1", principal: 50000, interestRateBps: 850, createdAt: "2026-09-01T00:00:00.000Z", watched: false },
  { id: "loan-2", principal: 120000, interestRateBps: 900, createdAt: "2026-09-02T00:00:00.000Z", watched: true },
];

const WATCHLIST = [
  {
    loanId: "loan-2",
    principal: 120000,
    interestRateBps: 900,
    state: "upcoming" as const,
    watchedSince: "2026-09-03T00:00:00.000Z",
    notifiedAt: null,
  },
  {
    loanId: "loan-9",
    principal: 30000,
    interestRateBps: 800,
    state: "open" as const,
    watchedSince: "2026-08-20T00:00:00.000Z",
    notifiedAt: "2026-09-10T00:00:00.000Z",
  },
];

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mockIsConnected = true;
  fetchUpcomingOfferingsMock.mockReset().mockResolvedValue(UPCOMING);
  fetchWatchlistMock.mockReset().mockResolvedValue(WATCHLIST);
  watchOfferingMock.mockReset().mockResolvedValue(undefined);
  unwatchOfferingMock.mockReset().mockResolvedValue(undefined);
});

describe("InvestorWatchlist (issue #799)", () => {
  it("prompts to connect a wallet and loads nothing when disconnected", async () => {
    mockIsConnected = false;
    render(<InvestorWatchlist />);
    await flush();

    expect(screen.getByText(/connect wallet to watch upcoming offerings/i)).toBeInTheDocument();
    expect(fetchUpcomingOfferingsMock).not.toHaveBeenCalled();
    expect(fetchWatchlistMock).not.toHaveBeenCalled();
  });

  it("shows upcoming offerings and a dedicated watchlist view with each item's state", async () => {
    render(<InvestorWatchlist />);
    await flush();

    expect(screen.getByTestId("upcoming-offering-loan-1")).toBeInTheDocument();
    expect(screen.getByTestId("watchlist-item-loan-2")).toHaveTextContent("Upcoming");
    expect(screen.getByTestId("watchlist-item-loan-9")).toHaveTextContent("Open for investment");
  });

  it("watches an unwatched upcoming offering and refreshes the lists", async () => {
    render(<InvestorWatchlist />);
    await flush();

    const row = screen.getByTestId("upcoming-offering-loan-1");
    await act(async () => {
      fireEvent.click(row.querySelector("button")!);
      await Promise.resolve();
    });

    expect(watchOfferingMock).toHaveBeenCalledWith("loan-1");
    expect(unwatchOfferingMock).not.toHaveBeenCalled();
    // initial load + refresh after the action
    expect(fetchWatchlistMock).toHaveBeenCalledTimes(2);
  });

  it("unwatches an already-watched offering from the upcoming list", async () => {
    render(<InvestorWatchlist />);
    await flush();

    const row = screen.getByTestId("upcoming-offering-loan-2");
    expect(row.querySelector("button")).toHaveTextContent("Unwatch");
    await act(async () => {
      fireEvent.click(row.querySelector("button")!);
      await Promise.resolve();
    });

    expect(unwatchOfferingMock).toHaveBeenCalledWith("loan-2");
  });

  it("removes an item directly from the watchlist view", async () => {
    render(<InvestorWatchlist />);
    await flush();

    const item = screen.getByTestId("watchlist-item-loan-9");
    await act(async () => {
      fireEvent.click(item.querySelector("button")!);
      await Promise.resolve();
    });

    expect(unwatchOfferingMock).toHaveBeenCalledWith("loan-9");
  });

  it("shows an error message instead of crashing when loading fails", async () => {
    fetchUpcomingOfferingsMock.mockRejectedValue(new Error("network"));
    render(<InvestorWatchlist />);
    await flush();

    expect(screen.getByText(/couldn't load your watchlist/i)).toBeInTheDocument();
  });

  it("surfaces the server's message when watching fails", async () => {
    watchOfferingMock.mockRejectedValue(new Error("Only upcoming offerings can be watched."));
    render(<InvestorWatchlist />);
    await flush();

    const row = screen.getByTestId("upcoming-offering-loan-1");
    await act(async () => {
      fireEvent.click(row.querySelector("button")!);
      await Promise.resolve();
    });

    expect(screen.getByText(/only upcoming offerings can be watched/i)).toBeInTheDocument();
  });
});
