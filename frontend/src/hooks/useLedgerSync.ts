// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useState, useEffect, useCallback } from 'react';

export interface SyncMetrics {
  currentLedger: number;
  indexerHeight: number;
  isSynced: boolean;
  latencyMs: number;
  lastUpdated: Date;
}

/**
 * useLedgerSync: Custom hook for managing ledger synchronization polling
 * and metrics. Tracks the gap between RPC sequence and backend indexer height.
 */
export const useLedgerSync = (pollIntervalMs = 5000, toleranceLedgers = 2) => {
  const [metrics, setMetrics] = useState<SyncMetrics>({
    currentLedger: 0,
    indexerHeight: 0,
    isSynced: false,
    latencyMs: 0,
    lastUpdated: new Date(),
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchSyncMetrics = useCallback(async () => {
    try {
      setError(null);

      // Fetch current ledger sequence from Stellar RPC
      const rpcRes = await fetch('/api/ledger/current-sequence', {
        headers: { 'Cache-Control': 'no-cache' },
      });
      if (!rpcRes.ok) throw new Error('Failed to fetch ledger sequence');
      const { sequence: currentLedger } = await rpcRes.json();

      // Fetch indexer height from backend
      const indexerRes = await fetch('/api/indexer/height', {
        headers: { 'Cache-Control': 'no-cache' },
      });
      if (!indexerRes.ok) throw new Error('Failed to fetch indexer height');
      const { height: indexerHeight } = await indexerRes.json();

      const gap = Math.abs(currentLedger - indexerHeight);
      const latencyMs = gap * 5000; // ~5 seconds per ledger
      const isSynced = gap <= toleranceLedgers;

      setMetrics({
        currentLedger,
        indexerHeight,
        isSynced,
        latencyMs,
        lastUpdated: new Date(),
      });

      setIsLoading(false);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown sync error');
      setError(error);
      console.error('Ledger sync error:', error);
    }
  }, [toleranceLedgers]);

  useEffect(() => {
    // Initial fetch
    fetchSyncMetrics();

    // Setup polling
    const interval = setInterval(fetchSyncMetrics, pollIntervalMs);

    return () => clearInterval(interval);
  }, [fetchSyncMetrics, pollIntervalMs]);

  return { metrics, isLoading, error, refetch: fetchSyncMetrics };
};

export default useLedgerSync;
