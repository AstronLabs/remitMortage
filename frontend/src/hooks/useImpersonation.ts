"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
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
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  const endSession = useCallback(async () => {
    setEnding(true);
    try {
      await endImpersonationRequest(status.sessionId ?? undefined);
      setStatus(INACTIVE_STATUS);
    } finally {
      setEnding(false);
    }
  }, [status.sessionId]);

  return { status, ending, endSession, refresh };
}
