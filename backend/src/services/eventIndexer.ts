import { loadConfig } from "../config.js";
import {
  createRpcFetcher,
  decodeEvent,
  classifyTopic,
  computeBackoff,
  EventFetcher,
  EventBatch,
  NormalizedEvent,
} from "./eventListener.js";
import {
  loadIndexerState,
  saveIndexerState,
  recordEscrowDeposit,
  recordEscrowWithdrawal,
  recordLoanDisbursement,
  recordLoanRepayment,
} from "./db.js";

export const DEFAULT_EVENT_INDEXER_POLL_MS = 5_000;
export const DEFAULT_EVENT_INDEXER_BASE_BACKOFF_MS = 1_000;
export const DEFAULT_EVENT_INDEXER_MAX_BACKOFF_MS = 30_000;
export const INDEXER_STATE_KEY = "soroban_event_indexer";

export interface EventIndexerOptions {
  rpcUrl?: string;
  escrowContractId?: string;
  lendingPoolContractId?: string;
  pollIntervalMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  fetcher?: EventFetcher;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class SorobanEventIndexer {
  private fetcher: EventFetcher | null;
  private readonly logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  private running = false;
  private cursor: string | null = null;
  private lastProcessedLedger = 0;
  private runPromise: Promise<void> | null = null;
  private readonly rpcUrl: string;
  private readonly escrowContractId?: string;
  private readonly lendingPoolContractId?: string;
  private readonly fetcherFactory: ((startLedger?: number) => EventFetcher) | null;

  constructor(options: EventIndexerOptions = {}) {
    const config = loadConfig();
    this.rpcUrl = options.rpcUrl ?? process.env.SOROBAN_RPC_URL ?? config.sorobanRpcUrl;
    this.escrowContractId = options.escrowContractId ?? config.escrowContractId;
    this.lendingPoolContractId =
      options.lendingPoolContractId ?? config.lendingPoolContractId;

    this.fetcher = options.fetcher ?? null;
    this.fetcherFactory =
      options.fetcher
        ? null
        : (startLedger?: number) =>
            createRpcFetcher({
              rpcUrl: this.rpcUrl,
              escrowContractId: this.escrowContractId,
              lendingPoolContractId: this.lendingPoolContractId,
              startLedger,
            });
    this.logger = options.logger ?? console;
    this.sleep = options.sleep ?? defaultSleep;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_EVENT_INDEXER_POLL_MS;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_EVENT_INDEXER_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_EVENT_INDEXER_MAX_BACKOFF_MS;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.runPromise = this.loop();
    this.logger.info("[event-indexer] started");
  }

  stop(): void {
    this.running = false;
  }

  async waitForStop(): Promise<void> {
    await this.runPromise;
  }

  private async initializeState(): Promise<void> {
    const state = await loadIndexerState(INDEXER_STATE_KEY);
    this.cursor = state.cursor;
    this.lastProcessedLedger = state.lastProcessedLedger;
    if (!this.fetcher && this.fetcherFactory) {
      this.fetcher = this.fetcherFactory(this.lastProcessedLedger + 1);
    }
    this.logger.info(
      `[event-indexer] initialized from state ledger=${this.lastProcessedLedger} cursor=${String(
        this.cursor
      )}`
    );
  }

  private async loop(): Promise<void> {
    await this.initializeState();

    let attempt = 0;
    while (this.running) {
      try {
        const batch = await this.fetcher!(this.cursor);
        for (const event of batch.events) {
          await this.processEvent(event);
        }

        if (batch.cursor) {
          this.cursor = batch.cursor;
        }

        if (batch.latestLedger > this.lastProcessedLedger) {
          this.lastProcessedLedger = batch.latestLedger;
        }

        await saveIndexerState(INDEXER_STATE_KEY, this.lastProcessedLedger, this.cursor);
        attempt = 0;
        await this.sleep(this.pollIntervalMs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const delay = computeBackoff(attempt, this.baseBackoffMs, this.maxBackoffMs);
        this.logger.error(`[event-indexer] RPC error: ${message}`);
        this.logger.warn(
          `[event-indexer] reconnecting in ${delay}ms (attempt ${attempt + 1})`
        );
        attempt += 1;
        await this.sleep(delay);
      }
    }
    this.logger.info("[event-indexer] stopped");
  }

  private async processEvent(event: NormalizedEvent): Promise<void> {
    const kind = classifyTopic(event.topic);
    if (!kind) return;
    if (!event.borrower || !event.amount) {
      this.logger.warn(
        `[event-indexer] skipping ${event.topic} event missing borrower/amount ledger=${event.ledger}`
      );
      return;
    }

    if (event.ledger <= this.lastProcessedLedger) {
      this.logger.info(
        `[event-indexer] skipping already processed ledger=${event.ledger} borrower=${event.borrower}`
      );
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
        // release events do not change borrower balance totals directly.
        break;
    }

    this.logger.info(
      `[event-indexer] ${kind} amount=${event.amount} borrower=${event.borrower} ledger=${event.ledger}`
    );
  }
}

export function startEventIndexer(overrides: EventIndexerOptions = {}) {
  const indexer = new SorobanEventIndexer(overrides);
  indexer.start();
  return indexer;
}
