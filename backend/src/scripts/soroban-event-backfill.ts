// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { loadConfig } from "../config.js";
import {
  createRpcFetcher,
  classifyTopic,
  type EventFetcher,
  type NormalizedEvent,
} from "../services/eventListener.js";
import {
  disconnect,
  loadIndexerState,
  recordEscrowDeposit,
  recordEscrowWithdrawal,
  recordLoanDisbursement,
  recordLoanRepayment,
  saveIndexerState,
} from "../services/db.js";
import {
  runBackfill,
  type BackfillDefinition,
  type BackfillLogger,
  type BackfillProgress,
  type BackfillStore,
  type BackfillSummary,
} from "../services/backfill.js";
import logger from "../utils/logger.js";

const BACKFILL_STATE_KEY = "soroban_event_backfill";
const BACKFILL_NAME = "event-backfill";

interface BackfillArgs {
  startLedger: number;
  endLedger: number;
}

/** Resume point: the RPC paging cursor plus the ledger high-water mark. */
interface BackfillCursor {
  cursor: string | null;
  lastProcessedLedger: number;
}

export function parseLedger(value: string | undefined, label: string): number {
  if (value == null) {
    throw new Error(`Missing required ${label} ledger argument`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Invalid ${label} ledger: ${value}`);
  }

  return parsed;
}

export function parseArgs(argv: string[]): BackfillArgs {
  const startLedger = parseLedger(argv[0], "start");
  const endLedger = parseLedger(argv[1], "end");

  if (startLedger > endLedger) {
    throw new Error("Start ledger must be less than or equal to end ledger");
  }

  return { startLedger, endLedger };
}

async function applyEvent(event: NormalizedEvent): Promise<void> {
  const kind = classifyTopic(event.topic);
  if (!kind) {
    return;
  }

  if (!event.borrower || !event.amount) {
    logger.warn(
      `[${BACKFILL_NAME}] skipping ${event.topic} event missing borrower/amount ledger=${event.ledger}`
    );
    return;
  }

  switch (kind) {
    case "deposit":
      await recordEscrowDeposit(event.borrower, event.contractId, event.amount, event.ledger);
      break;
    case "withdraw":
      await recordEscrowWithdrawal(event.borrower, event.contractId, event.amount, event.ledger);
      break;
    case "disburse":
      await recordLoanDisbursement(event.borrower, event.contractId, event.amount, event.ledger);
      break;
    case "repay":
      await recordLoanRepayment(event.borrower, event.contractId, event.amount, event.ledger);
      break;
    case "release":
      break;
  }
}

function createDefaultFetcher(resumeLedger: number): EventFetcher {
  const config = loadConfig();
  return createRpcFetcher({
    rpcUrl: config.sorobanRpcUrl,
    escrowContractId: config.escrowContractId || undefined,
    lendingPoolContractId: config.lendingPoolContractId || undefined,
    startLedger: resumeLedger,
  });
}

/** Estimates the total batch count from how much of the ledger range is done. */
function estimateTotalBatches(
  startLedger: number,
  endLedger: number,
  lastProcessedLedger: number,
  progress: BackfillProgress
): number | undefined {
  if (progress.completedBatches === 0 || endLedger <= startLedger) {
    return undefined;
  }

  const span = endLedger - startLedger + 1;
  const covered = Math.min(Math.max(lastProcessedLedger - startLedger + 1, 0), span);
  if (covered <= 0) {
    return undefined;
  }

  const fraction = covered / span;
  if (fraction >= 1) {
    return progress.completedBatches;
  }

  return Math.max(progress.completedBatches, Math.ceil(progress.completedBatches / fraction));
}

export interface SorobanBackfillDeps {
  /** Injectable event source; defaults to a live Soroban RPC poller. */
  fetcher?: EventFetcher;
  /** Injectable progress logger; defaults to the shared winston logger. */
  logger?: BackfillLogger;
}

export async function runSorobanEventBackfill(
  startLedger: number,
  endLedger: number,
  deps: SorobanBackfillDeps = {}
): Promise<BackfillSummary> {
  const progressLogger = deps.logger ?? logger;
  const persisted = await loadIndexerState(BACKFILL_STATE_KEY);
  const resumeLedger = Math.max(startLedger, persisted.lastProcessedLedger + 1);
  const fetcher = deps.fetcher ?? createDefaultFetcher(resumeLedger);

  let lastProcessedLedger = persisted.lastProcessedLedger;
  const hasCheckpoint = persisted.lastProcessedLedger > 0 || persisted.cursor !== null;

  const store: BackfillStore<BackfillCursor> = {
    load: async () =>
      hasCheckpoint
        ? { cursor: persisted.cursor, lastProcessedLedger: persisted.lastProcessedLedger }
        : null,
    save: async (checkpoint) => {
      await saveIndexerState(BACKFILL_STATE_KEY, checkpoint.lastProcessedLedger, checkpoint.cursor);
    },
  };

  const definition: BackfillDefinition<NormalizedEvent, BackfillCursor> = {
    name: BACKFILL_NAME,
    describeStart: () => ({ range: `${startLedger}-${endLedger}`, resumeLedger }),
    fetchBatch: async (checkpoint) => {
      const batch = await fetcher(checkpoint.cursor);
      const items: NormalizedEvent[] = [];
      let reachedEndOfRange = false;

      for (const event of batch.events) {
        if (event.ledger < resumeLedger) {
          continue;
        }

        if (event.ledger > endLedger) {
          reachedEndOfRange = true;
          break;
        }

        items.push(event);
        lastProcessedLedger = Math.max(lastProcessedLedger, event.ledger);
      }

      if (batch.latestLedger > lastProcessedLedger) {
        lastProcessedLedger = batch.latestLedger;
      }

      const done = reachedEndOfRange || lastProcessedLedger >= endLedger || !batch.cursor;
      return { items, cursor: { cursor: batch.cursor, lastProcessedLedger }, done };
    },
    processBatch: async (items) => {
      for (const event of items) {
        await applyEvent(event);
      }
    },
    estimateTotalBatches: (progress) =>
      estimateTotalBatches(startLedger, endLedger, lastProcessedLedger, progress),
  };

  return runBackfill(
    definition,
    store,
    { cursor: persisted.cursor, lastProcessedLedger: persisted.lastProcessedLedger },
    progressLogger
  );
}

async function main(): Promise<void> {
  const [startArg, endArg] = process.argv.slice(2);
  const { startLedger, endLedger } = parseArgs([startArg, endArg]);

  try {
    await runSorobanEventBackfill(startLedger, endLedger);
  } finally {
    await disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
