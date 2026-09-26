// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * GET /metrics
 *
 * Exposes all registered Prometheus metrics in the standard text exposition
 * format (content-type: text/plain; version=0.0.4).
 *
 * Security:
 *   The route is protected by `metricsAuthMiddleware` which checks for a
 *   static bearer token from the `METRICS_TOKEN` environment variable.
 *   When the variable is unset the endpoint is open (dev convenience).
 *
 * Prometheus scrape configuration example:
 *
 *   scrape_configs:
 *     - job_name: remitmortgage_backend
 *       static_configs:
 *         - targets: ["api:4000"]
 *       metrics_path: /metrics
 *       authorization:
 *         type: Bearer
 *         credentials: <METRICS_TOKEN>
 */

import { Router, Request, Response } from "express";
import { metricsRegistry } from "../services/metrics.js";
import { metricsAuthMiddleware } from "../middleware/metricsMiddleware.js";

export const metricsRouter = Router();

/**
 * @openapi
 * /metrics:
 *   get:
 *     summary: Prometheus metrics endpoint
 *     description: >
 *       Returns all registered metrics in Prometheus text exposition format.
 *       Requires a valid Bearer token when METRICS_TOKEN is configured.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Prometheus text payload
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *       401:
 *         description: Missing or invalid bearer token
 */
metricsRouter.get(
  "/",
  metricsAuthMiddleware,
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const payload = await metricsRegistry.metrics();
      res
        .status(200)
        .set("Content-Type", metricsRegistry.contentType)
        .end(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : "metrics unavailable";
      res.status(500).json({ error: "metrics_error", message });
    }
  }
);
