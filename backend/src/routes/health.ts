// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router } from "express";
import { prisma } from "../services/db.js";
import { loadConfig } from "../config.js";
import { isShuttingDown } from "../services/gracefulShutdown.js";

export const healthRouter = Router();

// Exported so the public status endpoint can reuse this probe as its source of
// truth instead of duplicating the database health check.
export async function checkDatabaseHealth(): Promise<{ status: string; latencyMs?: number; error?: string }> {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "healthy", latencyMs: Date.now() - start };
  } catch (err: any) {
    return { status: "unhealthy", latencyMs: Date.now() - start, error: err.message };
  }
}

async function checkHorizonHealth(): Promise<{ status: string; latencyMs?: number; error?: string }> {
  const config = loadConfig();
  const start = Date.now();
  try {
    const response = await fetch(`${config.horizonUrl}`);
    if (!response.ok) {
      return { status: "unhealthy", latencyMs: Date.now() - start, error: `HTTP ${response.status}` };
    }
    return { status: "healthy", latencyMs: Date.now() - start };
  } catch (err: any) {
    return { status: "unhealthy", latencyMs: Date.now() - start, error: err.message };
  }
}

/**
 * @openapi
 * /api/health:
 *   get:
 *     summary: Check API health
 *     description: Returns detailed health status of all system components.
 *     tags:
 *       - Health
 *     responses:
 *       200:
 *         description: All services are healthy.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthResponse'
 *       503:
 *         description: One or more services are unhealthy.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthResponse'
 */
healthRouter.get("/", async (_req, res) => {
  // A draining instance reports unhealthy at once so load balancers stop
  // routing to it (issue #827).
  if (isShuttingDown()) {
    return res.status(503).json({
      status: "shutting_down",
      service: "remitmortgage-api",
      timestamp: new Date().toISOString(),
    });
  }

  const [database, horizon] = await Promise.all([
    checkDatabaseHealth(),
    checkHorizonHealth(),
  ]);

  const allHealthy = database.status === "healthy" && horizon.status === "healthy";

  const response = {
    status: allHealthy ? "ok" : "degraded",
    service: "remitmortgage-api",
    timestamp: new Date().toISOString(),
    components: {
      database,
      horizon,
    },
  };

  res.status(allHealthy ? 200 : 503).json(response);
});

/**
 * @openapi
 * /api/health/live:
 *   get:
 *     summary: Liveness probe
 *     description: >
 *       Always 200 while the process is running, including while it drains for
 *       shutdown, so an orchestrator does not kill an instance that is still
 *       finishing in-flight work.
 *     tags:
 *       - Health
 *     responses:
 *       200:
 *         description: The process is alive.
 */
healthRouter.get("/live", (_req, res) => {
  res.status(200).json({ status: "alive", timestamp: new Date().toISOString() });
});

/**
 * @openapi
 * /api/health/ready:
 *   get:
 *     summary: Readiness probe
 *     description: >
 *       200 when the instance can take traffic. Fails with 503 immediately once
 *       SIGTERM is received (before the database is consulted), and also when
 *       the database is unreachable.
 *     tags:
 *       - Health
 *     responses:
 *       200:
 *         description: Ready for traffic.
 *       503:
 *         description: Shutting down, or a dependency is unavailable.
 */
healthRouter.get("/ready", async (_req, res) => {
  if (isShuttingDown()) {
    return res.status(503).json({ status: "shutting_down", timestamp: new Date().toISOString() });
  }
  const database = await checkDatabaseHealth();
  const ready = database.status === "healthy";
  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    components: { database },
    timestamp: new Date().toISOString(),
  });
});
