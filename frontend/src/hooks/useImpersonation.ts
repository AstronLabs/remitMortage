"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useRef, useState } from "react";
import {
  IMPERSONATION_CHANGED_EVENT,
  endImpersonation as endImpersonationRequest,
  fetchImpersonationStatus,
  type ImpersonationStatus,
} from "../lib/impersonationApi";

const POLL_INTERVAL_MS = 20 * 1000;

const INACTIVE_STATUS: ImpersonationStatus = {
  active: false,
  sessionId: null,
  adminAddress: null,
  targetAddress: null,
  startedAt: null,
  expiresAt: null,
};

/**
 * Tracks whether this browser currently holds an active read-only
 * impersonation session, polling the backend rather than trusting local
 * state — the session's cookie is HttpOnly, and expiry/early-revocation only
 * the server knows about.
 */
export function useImpersonation() {
  const [status, setStatus] = useState<ImpersonationStatus>(INACTIVE_STATUS);
  const [ending, setEnding] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchImpersonationStatus();
      setStatus(next);
    } catch {
      // Network hiccup — keep the last known status rather than flashing the
      // banner away; the next poll will correct it either way.
    }
  }, []);

  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, POLL_INTERVAL_MS);
    // Start/end in this tab refresh every instance immediately, so the banner
    // appears the moment an admin enters the view rather than on the next poll.
    window.addEventListener(IMPERSONATION_CHANGED_EVENT, refresh);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      window.removeEventListener(IMPERSONATION_CHANGED_EVENT, refresh);
    };
  }, [refresh]);

  /** Ends the session; resolves with how long it lasted, in milliseconds. */
  const endSession = useCallback(async (): Promise<number | null> => {
    setEnding(true);
    try {
      await endImpersonationRequest(status.sessionId ?? undefined);
      const durationMs = status.startedAt
        ? Math.max(0, Date.now() - new Date(status.startedAt).getTime())
        : null;
      setStatus(INACTIVE_STATUS);
      return durationMs;
    } finally {
      setEnding(false);
    }
  }, [status.sessionId, status.startedAt]);

  return { status, ending, endSession, refresh };
}
