import { pathToFileURL } from "node:url";
import { loadConfig } from "../config.js";
import {
  createRpcFetcher,
  classifyTopic,
  type EventBatch,
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

const BACKFILL_STATE_KEY = "soroban_event_backfill";

interface BackfillArgs {
  startLedger: number;
  endLedger: number;
}

function parseLedger(value: string | undefined, label: string): number {
  if (value == null) {
    throw new Error(`Missing required ${label} ledger argument`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Invalid ${label} ledger: ${value}`);
  }

  return parsed;
}

function parseArgs(argv: string[]): BackfillArgs {
  const startLedger = parseLedger(argv[0], "start");
  const endLedger = parseLedger(argv[1], "end");

  if (startLedger > endLedger) {
    throw new Error("Start ledger must be less than or equal to end ledger");
  }

  return { startLedger, endLedger };
}

function makeLogger() {
  return console;
}

async function applyEvent(event: NormalizedEvent): Promise<void> {
  const kind = classifyTopic(event.topic);
  if (!kind) {
    return;
  }

  if (!event.borrower || !event.amount) {
    console.warn(
      `[event-backfill] skipping ${event.topic} event missing borrower/amount ledger=${event.ledger}`
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

async function runBackfill(startLedger: number, endLedger: number): Promise<void> {
  const config = loadConfig();
  const logger = makeLogger();
  const state = await loadIndexerState(BACKFILL_STATE_KEY);
  const resumeLedger = Math.max(startLedger, state.lastProcessedLedger + 1);
  const fetcher = createRpcFetcher({
    rpcUrl: config.sorobanRpcUrl,
    escrowContractId: config.escrowContractId || undefined,
    lendingPoolContractId: config.lendingPoolContractId || undefined,
    startLedger: resumeLedger,
  });

  let cursor = state.cursor;
  let lastProcessedLedger = state.lastProcessedLedger;
  let processedEvents = 0;

  logger.info(
    `[event-backfill] starting range=${startLedger}-${endLedger} resumeLedger=${resumeLedger} cursor=${String(
      cursor
    )}`
  );

  while (true) {
    const batch: EventBatch = await fetcher(cursor);
    let reachedEndOfRange = false;
    let processedThisBatch = 0;

    for (const event of batch.events) {
      if (event.ledger < resumeLedger) {
        continue;
      }

      if (event.ledger > endLedger) {
        reachedEndOfRange = true;
        break;
      }

      await applyEvent(event);
      processedEvents += 1;
      processedThisBatch += 1;
      lastProcessedLedger = Math.max(lastProcessedLedger, event.ledger);
    }

    if (batch.latestLedger > lastProcessedLedger) {
      lastProcessedLedger = batch.latestLedger;
    }

    cursor = batch.cursor;
    await saveIndexerState(BACKFILL_STATE_KEY, lastProcessedLedger, cursor);

    logger.info(
      `[event-backfill] batch processed=${processedThisBatch} total=${processedEvents} checkpoint=${lastProcessedLedger} cursor=${String(
        cursor
      )}`
    );

    if (reachedEndOfRange || lastProcessedLedger >= endLedger || !cursor) {
      break;
    }
  }

  logger.info(
    `[event-backfill] completed range=${startLedger}-${endLedger} processed=${processedEvents} checkpoint=${lastProcessedLedger}`
  );
}

async function main(): Promise<void> {
  const [startArg, endArg] = process.argv.slice(2);
  const { startLedger, endLedger } = parseArgs([startArg, endArg]);

  try {
    await runBackfill(startLedger, endLedger);
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
