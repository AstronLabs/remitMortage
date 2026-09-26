"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useState } from "react";
import {
  getVerificationStatus,
  type VerificationRecord,
} from "../lib/verification-registry";

export type VerificationStatus =
  | "idle"
  | "loading"
  | "verified"
  | "unverified"
  | "error";

export interface UseVerificationStatusResult {
  status: VerificationStatus;
  record: VerificationRecord | null;
  /** Verification expiry in Unix seconds, or null. */
  verifiedUntil: number | null;
  /** Force a fresh Horizon lookup, bypassing the cache. */
  refresh: () => void;
}

/**
 * Resolve and track the verification badge state for a wallet address.
 *
 * Runs a cached, de-duplicated Horizon lookup as soon as an address is provided
 * (i.e. right after wallet connection) and again whenever the address changes.
 * A null address resets to the idle state. Stale results from a previous address
 * are discarded via a cancellation guard so the badge never flickers to the
 * wrong wallet's status.
 */
export function useVerificationStatus(
  address: string | null
): UseVerificationStatusResult {
  const [status, setStatus] = useState<VerificationStatus>("idle");
  const [record, setRecord] = useState<VerificationRecord | null>(null);
  // Bumping this triggers a forced refresh in the effect below.
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  useEffect(() => {
    if (!address) {
      setStatus("idle");
      setRecord(null);
      return;
    }

    let cancelled = false;
    setStatus("loading");

    getVerificationStatus(address, { force: refreshKey > 0 })
      .then((result) => {
        if (cancelled) return;
        setRecord(result);
        setStatus(result.state);
      })
      .catch(() => {
        if (cancelled) return;
        setRecord(null);
        setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [address, refreshKey]);

  return {
    status,
    record,
    verifiedUntil: record?.verifiedUntil ?? null,
    refresh,
  };
}
