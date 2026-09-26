// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { renderHook, act } from "@testing-library/react";
import { useAutoRefresh } from "../useAutoRefresh";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

describe("useAutoRefresh", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    setVisibility("visible");
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("refreshes at the configured cadence while the tab is visible", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    renderHook(() => useAutoRefresh(refresh, 30_000));

    await advance(29_999);
    expect(refresh).not.toHaveBeenCalled();
    await advance(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await advance(30_000);
    await advance(30_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("switches cadence when the interval changes", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(({ ms }) => useAutoRefresh(refresh, ms), {
      initialProps: { ms: 300_000 },
    });

    await advance(60_000);
    expect(refresh).not.toHaveBeenCalled();

    rerender({ ms: 30_000 });
    await advance(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not poll when disabled or set to off", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    renderHook(() => useAutoRefresh(refresh, 0));
    renderHook(() => useAutoRefresh(refresh, 30_000, false));
    await advance(10 * 60_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("pauses while backgrounded and refreshes immediately on refocus", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    renderHook(() => useAutoRefresh(refresh, 30_000));

    act(() => setVisibility("hidden"));
    await advance(5 * 60_000);
    expect(refresh).not.toHaveBeenCalled();

    await act(async () => setVisibility("visible"));
    expect(refresh).toHaveBeenCalledTimes(1);

    await advance(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("never starts a second request while one is still in flight", async () => {
    let resolveRequest: () => void = () => {};
    const refresh = jest.fn(
      () => new Promise<void>((resolve) => {
        resolveRequest = resolve;
      })
    );
    renderHook(() => useAutoRefresh(refresh, 30_000));

    await advance(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    // Tick and refocus while the first request is pending: both are skipped.
    await advance(30_000);
    act(() => setVisibility("hidden"));
    await act(async () => setVisibility("visible"));
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => resolveRequest());
    await advance(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("keeps polling after a refresh fails", async () => {
    const refresh = jest.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    renderHook(() => useAutoRefresh(refresh, 30_000));
    await advance(30_000);
    await advance(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("stops polling on unmount", async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    const { unmount } = renderHook(() => useAutoRefresh(refresh, 30_000));
    unmount();
    await advance(60_000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
