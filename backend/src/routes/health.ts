import { Router } from "express";
import { prisma } from "../services/db.js";
import { loadConfig } from "../config.js";

export const healthRouter = Router();

async function checkDatabaseHealth(): Promise<{ status: string; latencyMs?: number; error?: string }> {
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
  const [database, horizon] = await Promise.all([
    checkDatabaseHealth(),
    checkHorizonHealth(),
  ]);

  const allHealthy = database.status === "healthy" && horizon.status === "healthy";

  const response = {
    status: allHealthy ? "ok" : "degraded",
    service: "remitmortage-api",
    timestamp: new Date().toISOString(),
    components: {
      database,
      horizon,
    },
  };

  res.status(allHealthy ? 200 : 503).json(response);
});
