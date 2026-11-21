// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Admin view of background jobs that exhausted their retries (issue #1103).
 * Mounted under `/api/admin` behind the standard admin authentication and
 * device binding.
 */

import { Router, Response } from "express";
import { requireAdmin, type AuthenticatedRequest } from "../middleware/auth.js";
import {
  DeadLetterJobNotFoundError,
  DeadLetterJobStateError,
  DeadLetterQueueUnavailableError,
  listDeadLetterJobs,
  requeueDeadLetterJob,
  type DeadLetterStatus,
  type QueueResolver,
} from "../services/deadLetterQueue.js";
import { queueService } from "../services/queueService.js";
import logger from "../utils/logger.js";

const DEAD_LETTER_STATUSES: DeadLetterStatus[] = ["dead", "requeued"];

/** Builds the router; the queue resolver is injectable for tests. */
export function createAdminDeadLetterRouter(
  resolveQueue: QueueResolver = (name) => queueService.getQueueByName(name)
): Router {
  const router = Router();

  /**
   * @openapi
   * /api/admin/dead-letter-jobs:
   *   get:
   *     summary: List background jobs that exhausted their retries
   *     description: >
   *       Jobs captured in the dead-letter queue with their original payload
   *       and last failure reason, most recent failure first. Defaults to jobs
   *       still awaiting a requeue.
   *     tags:
   *       - Admin
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: queue
   *         schema: { type: string }
   *       - in: query
   *         name: status
   *         schema: { type: string, enum: [dead, requeued] }
   *       - in: query
   *         name: limit
   *         schema: { type: integer, minimum: 1, maximum: 200 }
   *     responses:
   *       200:
   *         description: Dead-lettered jobs.
   *       400:
   *         description: Invalid filter.
   */
  router.get("/dead-letter-jobs", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
    const status = typeof req.query.status === "string" ? req.query.status : "dead";
    if (!DEAD_LETTER_STATUSES.includes(status as DeadLetterStatus)) {
      return res.status(400).json({ error: "invalid_status", message: "status must be dead or requeued" });
    }
    let limit: number | undefined;
    if (req.query.limit !== undefined) {
      limit = Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1) {
        return res.status(400).json({ error: "invalid_limit", message: "limit must be a positive integer" });
      }
    }
    const queueName = typeof req.query.queue === "string" && req.query.queue ? req.query.queue : undefined;

    try {
      const jobs = await listDeadLetterJobs({ status: status as DeadLetterStatus, queueName, limit });
      return res.json({ count: jobs.length, jobs });
    } catch (error) {
      logger.error("Dead-letter list error", { error });
      return res.status(500).json({ error: "failed_to_list_dead_letter_jobs" });
    }
  });

  /**
   * @openapi
   * /api/admin/dead-letter-jobs/{id}/requeue:
   *   post:
   *     summary: Requeue a dead-lettered job with its original payload
   *     tags:
   *       - Admin
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: The job was put back on its original queue.
   *       404:
   *         description: No dead-lettered job with that id.
   *       409:
   *         description: The job was already requeued.
   *       503:
   *         description: The job's queue is not available.
   */
  router.post("/dead-letter-jobs/:id/requeue", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
    const id = String(req.params.id);
    try {
      const job = await requeueDeadLetterJob(id, {
        resolveQueue,
        requeuedBy: req.user?.walletAddress,
      });
      return res.json({ requeued: true, job });
    } catch (error) {
      if (error instanceof DeadLetterJobNotFoundError) {
        return res.status(404).json({ error: error.code, message: error.message });
      }
      if (error instanceof DeadLetterJobStateError) {
        return res.status(409).json({ error: error.code, message: error.message });
      }
      if (error instanceof DeadLetterQueueUnavailableError) {
        return res.status(503).json({ error: error.code, message: error.message });
      }
      logger.error("Dead-letter requeue error", { error, id });
      return res.status(500).json({ error: "failed_to_requeue_dead_letter_job" });
    }
  });

  return router;
}

export const adminDeadLetterRouter = createAdminDeadLetterRouter();
