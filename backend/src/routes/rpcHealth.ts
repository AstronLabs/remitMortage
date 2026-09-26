// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router } from "express";
import { getRpcHealthMonitor } from "../services/rpcHealthMonitor.js";
import logger from "../utils/logger.js";

export const rpcHealthRouter = Router();

/**
 * @openapi
 * /api/health/rpc:
 *   get:
 *     summary: Check Soroban RPC node health
 *     description: >-
 *       Probes every configured Soroban RPC node in real time and reports each
 *       node's health (healthy, sync_delay, ledger_history or down), the ledger
 *       it has reached, and which node is currently selected for failover.
 *     tags:
 *       - Health
 *     responses:
 *       200:
 *         description: At least one RPC node is healthy.
 *       503:
 *         description: All RPC nodes are unhealthy.
 */
rpcHealthRouter.get("/", async (_req, res) => {
  const monitor = getRpcHealthMonitor();

  try {
    const nodes = await monitor.checkOnce();
    const activeUrl = monitor.getActiveUrl();
    const anyHealthy = nodes.some((node) => node.healthy);

    res.status(anyHealthy ? 200 : 503).json({
      status: anyHealthy ? "ok" : "unhealthy",
      service: "soroban-rpc",
      timestamp: new Date().toISOString(),
      activeUrl,
      nodes,
    });
  } catch (err: any) {
    logger.error("[rpcHealth] Health check failed", { error: err?.message });
    res.status(503).json({
      status: "unhealthy",
      service: "soroban-rpc",
      timestamp: new Date().toISOString(),
      error: err?.message ?? "RPC health check failed",
    });
  }
});
