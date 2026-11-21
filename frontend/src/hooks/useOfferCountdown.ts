"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useEffect, useState } from "react";
import {
  DEFAULT_URGENT_THRESHOLD_MS,
  getOfferCountdown,
  type OfferCountdownState,
} from "../lib/offerCountdown";

/**
 * Live countdown to an offer deadline. Re-renders every second and also arms
 * a timer for the exact deadline, so the offer flips to expired on time
 * without a page reload.
 */
export function useOfferCountdown(
  expiresAt: string | number | Date,
  urgentThresholdMs: number = DEFAULT_URGENT_THRESHOLD_MS
): OfferCountdownState {
  const deadline = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const remaining = deadline - Date.now();
    const tick = remaining > 0 ? setInterval(() => setNow(Date.now()), 1000) : undefined;
    // Fires at the exact deadline (or right away for a past/changed one) so
    // the offer flips to expired on time, then stops ticking.
    const atDeadline = setTimeout(
      () => {
        if (tick) clearInterval(tick);
        setNow(Date.now());
      },
      remaining > 0 ? remaining : 0
    );
    return () => {
      if (tick) clearInterval(tick);
      clearTimeout(atDeadline);
    };
  }, [deadline]);

  return getOfferCountdown(deadline, now, urgentThresholdMs);
}
