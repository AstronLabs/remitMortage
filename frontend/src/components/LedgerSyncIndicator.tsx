// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState, useEffect } from 'react';

interface SyncStatus {
  isSynced: boolean;
  currentLedger: number;
  indexerHeight: number;
  latencyMs: number;
  lastUpdated: Date;
}

/**
 * LedgerSyncIndicator: Displays real-time synchronization status between
 * the dashboard indexer and Stellar ledger sequence.
 * Provides visual indicators for sync completeness and latency.
 */
export const LedgerSyncIndicator: React.FC = () => {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    isSynced: true,
    currentLedger: 0,
    indexerHeight: 0,
    latencyMs: 0,
    lastUpdated: new Date(),
  });
  const [isLoading, setIsLoading] = useState(true);
  const [animationClass, setAnimationClass] = useState('transition-opacity');

  useEffect(() => {
    const pollInterval = setInterval(async () => {
      try {
        // Fetch current ledger sequence from RPC
        const rpcResponse = await fetch('/api/ledger/current-sequence');
        const { sequence: currentLedger } = await rpcResponse.json();

        // Fetch indexer height from backend
        const indexerResponse = await fetch('/api/indexer/height');
        const { height: indexerHeight } = await indexerResponse.json();

        const latencyMs = Math.abs(currentLedger - indexerHeight) * 5; // ~5s per ledger
        const isSynced = Math.abs(currentLedger - indexerHeight) <= 2; // Within 2 ledgers

        // Trigger smooth transition animation
        setAnimationClass('transition-all duration-300 opacity-100');

        setSyncStatus({
          isSynced,
          currentLedger,
          indexerHeight,
          latencyMs,
          lastUpdated: new Date(),
        });

        setIsLoading(false);
      } catch (error) {
        console.error('Failed to fetch sync status:', error);
      }
    }, 5000); // Poll every 5 seconds

    return () => clearInterval(pollInterval);
  }, []);

  const statusColor = syncStatus.isSynced
    ? 'text-green-600 bg-green-50'
    : syncStatus.latencyMs > 30000
      ? 'text-red-600 bg-red-50'
      : 'text-yellow-600 bg-yellow-50';

  const statusDot = syncStatus.isSynced
    ? 'animate-pulse bg-green-600'
    : 'animate-pulse bg-yellow-600';

  return (
    <div
      className={`flex items-center gap-3 px-4 py-2 rounded-lg border ${statusColor} ${animationClass}`}
    >
      {/* Status Indicator Dot */}
      <div className={`w-3 h-3 rounded-full ${statusDot}`} />

      {/* Status Text */}
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">
          {isLoading ? 'Ledger Sync: Loading...' : syncStatus.isSynced ? 'In Sync' : 'Syncing...'}
        </span>

        {/* Latency Information */}
        {!isLoading && (
          <span className="text-xs opacity-75">
            Ledger: {syncStatus.currentLedger} | Indexer: {syncStatus.indexerHeight} | Latency:{' '}
            {syncStatus.latencyMs}ms
          </span>
        )}
      </div>

      {/* Last Updated Badge */}
      {!isLoading && (
        <span className="ml-auto text-xs opacity-60">
          {syncStatus.lastUpdated.toLocaleTimeString()}
        </span>
      )}
    </div>
  );
};

export default LedgerSyncIndicator;
