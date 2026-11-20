// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Admin view of per-route latency budget breaches (issue #988). Mounted under
 * `/api/admin` behind the standard admin authentication and device binding.
 */

import { Router, Response } from "express";
import { requireAdmin, type AuthenticatedRequest } from "../middleware/auth.js";
import { ROUTE_LATENCY_BUDGETS } from "../config/routeLatencyBudgets.js";
import { getLatencyBudgetViolations } from "../services/latencyBudgetMonitor.js";

export const adminLatencyRouter = Router();

/**
 * @openapi
 * /api/admin/latency-budget-violations:
 *   get:
 *     summary: Routes exceeding their latency budgets most often
 *     description: >
 *       Process-local summary of completed requests that took longer than the
 *       budget configured for their method and route template. Sorted by
 *       exceedance count, then exceedance ratio.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Ranked routes that exceeded their budget.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [generatedAt, defaultBudgetMs, routes]
 *               properties:
 *                 generatedAt:
 *                   type: string
 *                   format: date-time
 *                 defaultBudgetMs:
 *                   type: integer
 *                   minimum: 0
 *                 routes:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required: [method, route, budgetMs, requests, exceeded, exceededRatio, maxDurationMs, lastExceededAt]
 *                     properties:
 *                       method:
 *                         type: string
 *                       route:
 *                         type: string
 *                       budgetMs:
 *                         type: integer
 *                       requests:
 *                         type: integer
 *                       exceeded:
 *                         type: integer
 *                       exceededRatio:
 *                         type: number
 *                       maxDurationMs:
 *                         type: integer
 *                       lastExceededAt:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *       401:
 *         description: Admin authentication required.
 *       403:
 *         description: Caller is not an admin.
 */
adminLatencyRouter.get(
  "/latency-budget-violations",
  requireAdmin,
  (_req: AuthenticatedRequest, res: Response) => {
    res.json({
      generatedAt: new Date().toISOString(),
      defaultBudgetMs: ROUTE_LATENCY_BUDGETS.defaultMs,
      routes: getLatencyBudgetViolations(),
    });
  }
);
