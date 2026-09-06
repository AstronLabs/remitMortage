import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { prisma } from "../services/db.js";
import logger from "../utils/logger.js";

export const auditRouter = Router();

/** Query durations above this are logged so slow-query regressions surface under load. */
const SLOW_QUERY_THRESHOLD_MS = 50;

/**
 * @openapi
 * /api/audit-logs:
 *   get:
 *     summary: Query historical transaction logs
 *     description: >-
 *       Returns keyset (cursor) paginated audit logs, filterable by event type
 *       and actor. Cursor pagination is used instead of OFFSET/COUNT so deep
 *       pages over large event tables stay fast and don't hold read locks
 *       during concurrent write spikes. Admin access only.
 *     tags:
 *       - Audit
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: Id of the last record from the previous page. Omit for the first page.
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Number of records per page
 *       - in: query
 *         name: action
 *         schema:
 *           type: string
 *         description: Filter by action name (event type)
 *       - in: query
 *         name: actorAddress
 *         schema:
 *           type: string
 *         description: Filter by actor wallet address
 *     responses:
 *       200:
 *         description: A cursor-paginated list of audit logs
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       500:
 *         description: Server error
 */
auditRouter.get("/", requireAdmin, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit as string) || 20));
    const cursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : undefined;

    const action = req.query.action as string | undefined;
    const actorAddress = req.query.actorAddress as string | undefined;

    const where: any = {};
    if (action) where.action = action;
    if (actorAddress) where.actorAddress = actorAddress;

    const startedAt = process.hrtime.bigint();

    // Keyset (cursor) pagination on the (action, createdAt) index: no OFFSET
    // scan and no COUNT(*) over the full result set, which is what caused CPU
    // spikes/lock contention on large transaction histories. One extra row is
    // fetched to cheaply detect whether a next page exists.
    const rows = await prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? ({ cursor: ({ id: cursor } as any), skip: 1 } as any) : {}),
    });

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
      logger.warn("Audit log query exceeded latency budget", {
        durationMs,
        limit,
        action,
        actorAddress,
        cursor,
      });
    }

    const hasNextPage = rows.length > limit;
    const data = hasNextPage ? rows.slice(0, limit) : rows;
    const nextCursor = hasNextPage ? data[data.length - 1].id : null;

    return res.json({
      data,
      pagination: {
        limit,
        cursor: cursor ?? null,
        nextCursor,
        hasNextPage,
      },
    });
  } catch (error) {
    console.error("Audit query error:", error);
    return res.status(500).json({ error: "Failed to query audit logs" });
  }
});
