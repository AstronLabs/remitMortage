// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { processNextEvent, type LedgerEventJob, getQueueDepth, getDlqDepth } from "./eventProducer.js";
import { balanceRepository } from "./balanceStore.js";
import { logAudit } from "./audit.js";
import { deleteCacheByPattern } from "./redis.js";
import { dispatchEvent, type EventTopic } from "./webhook.js";
import { indexerEventsProcessedTotal, indexerEventsSkippedTotal } from "./metrics.js";
import logger from "../utils/logger.js";

/** Topics we recognise and forward. */
const KNOWN_TOPICS = new Set(["deposit", "withdraw", "release", "disburse", "repay"]);

/**
 * Process a single ledger event job by dispatching to the balance store,
 * audit log, and webhook fan-out.
 */
async function handleJob(job: LedgerEventJob): Promise<void> {
  const { topic, borrower, amount, ledger, contractId } = job;

  if (!borrower || !amount) {
    logger.warn(`[event-worker] skipping ${topic} event missing borrower/amount`);
    indexerEventsSkippedTotal.inc({ topic });
    return;
  }

  if (!KNOWN_TOPICS.has(topic)) {
    logger.warn(`[event-worker] unknown topic ${topic}, skipping`);
    indexerEventsSkippedTotal.inc({ topic });
    return;
  }

  // ── Balance store updates ──────────────────────────────────────────
  switch (topic) {
    case "deposit":
      balanceRepository.applyEscrowDeposit(borrower, amount, ledger);
      break;
    case "withdraw":
      balanceRepository.applyEscrowWithdraw(borrower, amount, ledger);
      break;
    case "disburse":
      balanceRepository.applyDisbursement(borrower, amount, ledger);
      break;
    case "repay":
      balanceRepository.applyRepayment(borrower, amount, ledger);
      break;
    case "release":
      // Escrow target met; no balance change.
      break;
  }

  indexerEventsProcessedTotal.inc({ topic });

  logger.info(
    `[event-worker] ${topic} amount=${amount} borrower=${borrower} ledger=${ledger}`
  );

  // ── Audit trail ────────────────────────────────────────────────────
  await logAudit({
    action: `onchain.${topic}`,
    actorAddress: borrower,
    metadata: { amount, ledger, contractId },
  });

  // ── Webhook fan-out ────────────────────────────────────────────────
  if (topic !== "release") {
    dispatchEvent(topic as EventTopic, {
      contractId,
      borrower,
      amount,
      ledger,
    });
  }

  // ── Cache invalidation ─────────────────────────────────────────────
  await deleteCacheByPattern("analytics:*");
}

/**
 * Run a continuous event-processing loop that pulls jobs from the Redis queue.
 * Call `abortController.signal` to stop gracefully.
 */
export async function runEventWorkerLoop(abortSignal?: AbortSignal): Promise<void> {
  logger.info("[event-worker] starting worker loop");

  while (!abortSignal?.aborted) {
    try {
      const processed = await processNextEvent(handleJob);
      if (!processed) {
        // Queue empty — yield the event loop briefly.
        await sleep(100);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[event-worker] unhandled error in worker loop", { error: message });
      await sleep(1000);
    }
  }

  logger.info("[event-worker] worker loop stopped");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns diagnostic info about the current queue state.
 */
export async function getWorkerDiagnostics(): Promise<{
  queueDepth: number;
  dlqDepth: number;
  isRunning: boolean;
}> {
  return {
    queueDepth: await getQueueDepth(),
    dlqDepth: await getDlqDepth(),
    isRunning: true,
  };
}
