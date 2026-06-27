import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { loadConfig } from "../config.js";
import {
  balanceRepository,
  BorrowerBalanceRepository,
} from "./balanceStore.js";

/** Soroban testnet RPC endpoint. */
export const SOROBAN_TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";

export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_BASE_BACKOFF_MS = 1_000;
export const DEFAULT_MAX_BACKOFF_MS = 30_000;

/** Escrow contract event topics we care about. */
export type EscrowTopic = "deposit" | "withdraw" | "release";
/** Lending-pool contract event topics we care about. */
export type PoolTopic = "disburse" | "repay";
export type EventKind = EscrowTopic | PoolTopic;

const ESCROW_TOPICS: ReadonlySet<string> = new Set(["deposit", "withdraw", "release"]);
const POOL_TOPICS: ReadonlySet<string> = new Set(["disburse", "repay"]);

/** A contract event normalized into the fields the listener acts on. */
export interface NormalizedEvent {
  contractId: string;
  /** First event topic, e.g. "deposit" / "disburse". */
  topic: string;
  borrower: string | null;
  amount: string | null;
  ledger: number;
}

export interface EventBatch {
  events: NormalizedEvent[];
  /** Paging cursor to resume from on the next poll (null to keep current). */
  cursor: string | null;
  latestLedger: number;
}

/** Fetches a batch of events starting after `cursor` (or from a recent ledger). */
export type EventFetcher = (cursor: string | null) => Promise<EventBatch>;

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface EventListenerOptions {
  rpcUrl?: string;
  escrowContractId?: string;
  lendingPoolContractId?: string;
  pollIntervalMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Injectable event source (defaults to a live Soroban RPC poller). */
  fetcher?: EventFetcher;
  repository?: BorrowerBalanceRepository;
  logger?: Logger;
  /** Injectable delay (defaults to setTimeout); overridden in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Exponential backoff for reconnection: 1s, 2s, 4s, 8s, ... capped at `max`.
 * `attempt` is zero-based (attempt 0 → `base`).
 */
export function computeBackoff(
  attempt: number,
  base: number = DEFAULT_BASE_BACKOFF_MS,
  max: number = DEFAULT_MAX_BACKOFF_MS
): number {
  return Math.min(base * 2 ** attempt, max);
}

/** Maps a raw event topic to a known event kind, or null if irrelevant. */
export function classifyTopic(topic: string): EventKind | null {
  if (ESCROW_TOPICS.has(topic) || POOL_TOPICS.has(topic)) {
    return topic as EventKind;
  }
  return null;
}

/**
 * Decodes a raw Soroban RPC event (XDR ScVals) into a {@link NormalizedEvent}.
 * Expects the conventional `(topic_symbol, borrower_address)` topic layout with
 * the amount carried in the event value (either a scalar or an `{ amount }` map).
 */
export function decodeEvent(raw: {
  contractId?: unknown;
  topic: xdr.ScVal[];
  value?: xdr.ScVal;
  ledger: number;
}): NormalizedEvent {
  const topics = (raw.topic ?? []).map((t) => scValToNative(t));
  const topic = topics.length > 0 ? String(topics[0]) : "";

  let borrower: string | null = null;
  if (topics.length > 1 && typeof topics[1] === "string") {
    borrower = topics[1];
  }

  let amount: string | null = null;
  const value = raw.value ? scValToNative(raw.value) : null;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (obj.borrower != null) borrower = String(obj.borrower);
    if (obj.amount != null) amount = String(obj.amount);
  } else if (
    typeof value === "bigint" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    amount = String(value);
  }

  return {
    contractId: raw.contractId != null ? String(raw.contractId) : "",
    topic,
    borrower,
    amount,
    ledger: raw.ledger,
  };
}

/**
 * Builds a live Soroban RPC event poller. Construction does no network I/O;
 * the first request happens when the returned fetcher is invoked.
 */
export function createRpcFetcher(opts: {
  rpcUrl: string;
  escrowContractId?: string;
  lendingPoolContractId?: string;
}): EventFetcher {
  const server = new rpc.Server(opts.rpcUrl, {
    allowHttp: opts.rpcUrl.startsWith("http://"),
  });

  const contractIds = [opts.escrowContractId, opts.lendingPoolContractId].filter(
    (id): id is string => !!id
  );
  const filters: rpc.Api.EventFilter[] = [
    contractIds.length > 0
      ? { type: "contract", contractIds }
      : { type: "contract" },
  ];

  return async (cursor) => {
    const request: rpc.Server.GetEventsRequest = { filters };
    if (cursor) {
      request.cursor = cursor;
    } else {
      const latest = await server.getLatestLedger();
      request.startLedger = Math.max(latest.sequence - 100, 1);
    }

    const res = await server.getEvents(request);
    return {
      events: res.events.map((e) =>
        decodeEvent({
          contractId: e.contractId,
          topic: e.topic,
          value: e.value,
          ledger: e.ledger,
        })
      ),
      cursor: res.cursor ?? null,
      latestLedger: res.latestLedger,
    };
  };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Background service that polls Soroban RPC for escrow/lending-pool contract
 * events and syncs them into the borrower balance store. Resilient to RPC
 * outages: failures are caught and retried with exponential backoff, so the
 * Node process never crashes on a dropped connection.
 */
export class SorobanEventListener {
  private readonly fetcher: EventFetcher;
  private readonly repository: BorrowerBalanceRepository;
  private readonly logger: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  private running = false;
  private cursor: string | null = null;
  private runPromise: Promise<void> | null = null;

  constructor(options: EventListenerOptions = {}) {
    if (!options.fetcher) {
      throw new Error("SorobanEventListener requires a fetcher");
    }
    this.fetcher = options.fetcher;
    this.repository = options.repository ?? balanceRepository;
    this.logger = options.logger ?? console;
    this.sleep = options.sleep ?? defaultSleep;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Starts the poll loop in the background (idempotent). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info("[event-listener] started");
    this.runPromise = this.loop();
  }

  /** Signals the loop to stop after its current iteration. */
  stop(): void {
    this.running = false;
  }

  /** Resolves once the loop has fully stopped (useful for tests/shutdown). */
  async waitForStop(): Promise<void> {
    await this.runPromise;
  }

  private async loop(): Promise<void> {
    let attempt = 0;
    while (this.running) {
      try {
        const batch = await this.fetcher(this.cursor);
        for (const event of batch.events) {
          this.handleEvent(event);
        }
        if (batch.cursor) this.cursor = batch.cursor;
        attempt = 0; // healthy poll resets the backoff
        await this.sleep(this.pollIntervalMs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const delay = computeBackoff(attempt, this.baseBackoffMs, this.maxBackoffMs);
        this.logger.error(`[event-listener] RPC error: ${message}`);
        this.logger.warn(
          `[event-listener] reconnecting in ${delay}ms (attempt ${attempt + 1})`
        );
        attempt += 1;
        await this.sleep(delay);
      }
    }
    this.logger.info("[event-listener] stopped");
  }

  private handleEvent(event: NormalizedEvent): void {
    const kind = classifyTopic(event.topic);
    if (!kind) return;

    if (!event.borrower || !event.amount) {
      this.logger.warn(
        `[event-listener] skipping ${event.topic} event missing borrower/amount`
      );
      return;
    }

    switch (kind) {
      case "deposit":
        this.repository.applyEscrowDeposit(event.borrower, event.amount, event.ledger);
        break;
      case "withdraw":
        this.repository.applyEscrowWithdraw(event.borrower, event.amount, event.ledger);
        break;
      case "disburse":
        this.repository.applyDisbursement(event.borrower, event.amount, event.ledger);
        break;
      case "repay":
        this.repository.applyRepayment(event.borrower, event.amount, event.ledger);
        break;
      case "release":
        // Escrow target met; balance accounting is unchanged, just observed.
        break;
    }

    this.logger.info(
      `[event-listener] ${kind} amount=${event.amount} borrower=${event.borrower} ledger=${event.ledger}`
    );
  }
}

/**
 * Constructs and starts a {@link SorobanEventListener} wired to the configured
 * Soroban RPC endpoint and contract IDs. Returns the listener so the caller can
 * stop it on shutdown.
 */
export function startEventListener(
  overrides: EventListenerOptions = {}
): SorobanEventListener {
  const config = loadConfig();
  const rpcUrl =
    overrides.rpcUrl ?? process.env.SOROBAN_RPC_URL ?? SOROBAN_TESTNET_RPC_URL;
  const escrowContractId = overrides.escrowContractId ?? config.escrowContractId;
  const lendingPoolContractId =
    overrides.lendingPoolContractId ?? config.lendingPoolContractId;

  const fetcher =
    overrides.fetcher ??
    createRpcFetcher({ rpcUrl, escrowContractId, lendingPoolContractId });

  const listener = new SorobanEventListener({
    ...overrides,
    rpcUrl,
    escrowContractId,
    lendingPoolContractId,
    fetcher,
  });
  listener.start();
  return listener;
}
