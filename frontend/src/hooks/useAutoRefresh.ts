// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useEffect, useRef } from "react";

/**
 * Calls `refresh` every `intervalMs` while the tab is visible.
 *
 * Polling stops while the document is hidden and resumes on refocus with an
 * immediate refresh, so data is current as soon as the user returns. A tick
 * is skipped if the previous refresh is still in flight, which prevents
 * duplicate concurrent requests on slow networks or rapid visibility changes.
 * An `intervalMs` of 0 (or `enabled: false`) disables polling entirely.
 */
export function useAutoRefresh(
  refresh: () => Promise<unknown> | void,
  intervalMs: number,
  enabled = true,
) {
  const refreshRef = useRef(refresh);
  const inFlightRef = useRef(false);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!enabled || intervalMs <= 0 || typeof document === "undefined") return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        await refreshRef.current();
      } catch {
        // The refresh callback owns its own error state; a failed poll must
        // not stop future ticks.
      } finally {
        inFlightRef.current = false;
      }
    };

    const start = () => {
      if (timer === null) timer = setInterval(tick, intervalMs);
    };

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        stop();
      } else {
        void tick();
        start();
      }
    };

    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs, enabled]);
}
