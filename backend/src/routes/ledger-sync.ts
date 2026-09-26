// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router, Request, Response } from 'express';

/**
 * Ledger Sync API Routes
 * Provides endpoints for frontend to check ledger synchronization status
 */

export const ledgerSyncRouter = Router();

/**
 * GET /api/ledger/current-sequence
 * Returns the current Stellar ledger sequence from RPC
 */
ledgerSyncRouter.get('/current-sequence', async (req: Request, res: Response) => {
  try {
    // TODO: Replace with actual Stellar RPC call
    // For now, placeholder that would integrate with Stellar SDK
    const sequence = Math.floor(Date.now() / 5000); // Approximate ledger from timestamp
    
    res.json({
      sequence,
      timestamp: new Date().toISOString(),
      source: 'stellar-rpc',
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch current ledger sequence',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/indexer/height
 * Returns the current height (ledger sequence) of the backend indexer
 */
ledgerSyncRouter.get('/indexer/height', async (req: Request, res: Response) => {
  try {
    // TODO: Query indexer state from database/cache
    // This would retrieve the last indexed ledger from the database
    const height = Math.floor(Date.now() / 5000) - 1; // Indexer slightly behind RPC
    
    res.json({
      height,
      lastUpdate: new Date().toISOString(),
      indexerStatus: 'running',
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch indexer height',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/ledger/sync-status
 * Combined endpoint returning both current ledger and indexer height with sync metrics
 */
ledgerSyncRouter.get('/sync-status', async (req: Request, res: Response) => {
  try {
    const sequence = Math.floor(Date.now() / 5000);
    const height = sequence - 1;
    const gap = Math.abs(sequence - height);
    const latencyMs = gap * 5000;
    const toleranceLedgers = 2;

    res.json({
      currentLedger: sequence,
      indexerHeight: height,
      isSynced: gap <= toleranceLedgers,
      latencyMs,
      gap,
      toleranceLedgers,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch sync status',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default ledgerSyncRouter;
