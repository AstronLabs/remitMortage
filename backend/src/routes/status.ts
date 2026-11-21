// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router } from "express";
import { checkDatabaseHealth } from "./health.js";
import { getRpcHealthMonitor } from "../services/rpcHealthMonitor.js";
import { isShuttingDown } from "../services/gracefulShutdown.js";
import logger from "../utils/logger.js";

export const statusRouter = Router();

/** How long a computed public status is served before the probes run again. */
export const PUBLIC_STATUS_CACHE_TTL_MS = 10_000;

/** A single component is only ever reported as up or down — nothing else. */
export type ComponentState = "up" | "down";

export interface PublicStatus {
  status: ComponentState;
  components: {
    api: ComponentState;
    database: ComponentState;
    rpc: ComponentState;
  };
  timestamp: string;
}

let cache: { payload: PublicStatus; expiresAt: number } | null = null;

/** Test hook: drop any cached status so the next request re-runs the probes. */
export function clearPublicStatusCache(): void {
  cache = null;
}

/**
 * Reuse the RPC health monitor (the same probe that backs `/api/health/rpc`)
 * and reduce it to a single up/down signal. Node URLs, latencies and ledger
 * details are deliberately never propagated to the public payload.
 */
async function checkRpcConnectivity(): Promise<boolean> {
  try {
    const nodes = await getRpcHealthMonitor().checkOnce();
    return nodes.some((node) => node.healthy);
  } catch (err: any) {
    logger.error("[publicStatus] RPC probe threw", { error: err?.message });
    return false;
  }
}

/** Run every probe and reduce the results to a public, detail-free payload. */
async function buildPublicStatus(): Promise<PublicStatus> {
  const [database, rpcUp] = await Promise.all([
    checkDatabaseHealth(),
    checkRpcConnectivity(),
  ]);

  const apiUp = !isShuttingDown();
  const databaseUp = database.status === "healthy";

  const components = {
    api: apiUp ? "up" : "down",
    database: databaseUp ? "up" : "down",
    rpc: rpcUp ? "up" : "down",
  } as const;

  const allUp = apiUp && databaseUp && rpcUp;

  return {
    status: allUp ? "up" : "down",
    components,
    timestamp: new Date().toISOString(),
  };
}

/**
 * @openapi
 * /api/status:
 *   get:
 *     summary: Public component status
 *     description: >-
 *       Public, cache-friendly summary of whether the API, database and Soroban
 *       RPC connectivity are up or down. Only up/down states are exposed; no
 *       internal error details, hostnames or latencies are returned. The result
 *       is cached briefly so repeated requests do not hammer the internal probes.
 *     tags:
 *       - Health
 *     responses:
 *       200:
 *         description: Every component is up.
 *       503:
 *         description: One or more components are down.
 */
statusRouter.get("/", async (_req, res) => {
  const now = Date.now();

  if (cache && cache.expiresAt > now) {
    return res
      .status(cache.payload.status === "up" ? 200 : 503)
      .json(cache.payload);
  }

  const payload = await buildPublicStatus();
  cache = { payload, expiresAt: Date.now() + PUBLIC_STATUS_CACHE_TTL_MS };

  res.status(payload.status === "up" ? 200 : 503).json(payload);
});
