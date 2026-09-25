// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { BASE_FEE } from "@stellar/stellar-sdk";
import { loadConfig } from "../config.js";
import { RpcFailoverManager } from "./rpcFailover.js";
import logger from "../utils/logger.js";

export type FeeTier = "low" | "medium" | "high";

export interface FeeRecommendation {
  /** Recommended fee (in stroops) for non-urgent submissions. */
  low: number;
  /** Recommended fee (in stroops) for normal submissions. */
  medium: number;
  /** Recommended fee (in stroops) for time-sensitive submissions. */
  high: number;
  /** Ledger sequence observed when this recommendation was computed. */
  latestLedger: number;
  /** Timestamp (ms) this snapshot was computed. */
  updatedAt: number;
  /** True until the first successful RPC-backed refresh completes. */
  isFallback: boolean;
}

const DEFAULT_BASE_FEE = Number(BASE_FEE); // 100 stroops
const DEFAULT_POLL_INTERVAL_MS = 10_000;
/** Stellar's target ledger close cadence, used as the congestion baseline. */
const EXPECTED_LEDGER_INTERVAL_MS = 5_000;
/** Upper bound on how much ledger-cadence slowdown can scale fees. */
const MAX_CONGESTION_MULTIPLIER = 5;

const STATIC_FALLBACK: Omit<FeeRecommendation, "latestLedger" | "updatedAt"> = {
  low: DEFAULT_BASE_FEE,
  medium: DEFAULT_BASE_FEE * 2,
  high: DEFAULT_BASE_FEE * 5,
  isFallback: true,
};

/**
 * Minimal shape of the Soroban RPC calls this service depends on, so tests
 * can inject a fake without spinning up `RpcFailoverManager`'s real
 * per-node retry/timeout machinery.
 */
export interface FeeEstimatorRpc {
  execute<T>(
    operation: (server: import("@stellar/stellar-sdk").rpc.Server) => Promise<T>,
    context?: string
  ): Promise<T>;
}

/**
 * Polls the Soroban RPC on a fixed interval to keep an in-memory snapshot
 * of low/medium/high fee recommendations.
 *
 * `getRecommendation()`/`getFee()` never make a network call themselves —
 * they read the last computed snapshot — so they stay well under the RPC's
 * own multi-hundred-millisecond latency and are safe to call on every
 * transaction-submission path.
 */
export class FeeEstimatorService {
  private snapshot: FeeRecommendation;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastLedgerSeq: number | null = null;
  private lastLedgerSeenAt: number | null = null;

  constructor(
    private readonly rpc: FeeEstimatorRpc,
    private readonly pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS
  ) {
    // Seed a sane static fallback so callers never see a zeroed-out
    // recommendation before the first successful poll completes.
    this.snapshot = { ...STATIC_FALLBACK, latestLedger: 0, updatedAt: 0 };
  }

  /** Starts the background polling loop. Safe to call more than once. */
  start(): void {
    if (this.timer) {
      return;
    }
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.pollIntervalMs);
    // Don't let the poller keep the process alive on its own.
    this.timer.unref?.();
  }

  /** Stops the background polling loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Returns the current cached fee recommendation. Read-only, in-memory —
   * safe to call as often as needed.
   */
  getRecommendation(): FeeRecommendation {
    return this.snapshot;
  }

  /** Returns the recommended fee (in stroops) for a single tier. */
  getFee(tier: FeeTier): number {
    return this.snapshot[tier];
  }

  /**
   * Refreshes the cached snapshot from the Soroban RPC and returns it.
   *
   * Queries `getLatestLedger` on every call both to detect network
   * congestion (via ledger close cadence) and, best-effort, to fold in the
   * server-computed inclusion-fee percentiles from `getFeeStats` — the
   * two combine into a recommendation that adjusts to actual network
   * traffic rather than a fixed constant.
   */
  async refresh(): Promise<FeeRecommendation> {
    try {
      const latestLedger = await this.rpc.execute(
        (server) => server.getLatestLedger(),
        "feeEstimator:getLatestLedger"
      );

      const congestionMultiplier = this.observeLedgerCadence(
        latestLedger.sequence
      );

      let { low, medium, high } = STATIC_FALLBACK;

      try {
        const feeStats = await this.rpc.execute(
          (server) => server.getFeeStats(),
          "feeEstimator:getFeeStats"
        );
        const dist = feeStats.sorobanInclusionFee;
        if (dist) {
          low = Math.max(DEFAULT_BASE_FEE, Number(dist.p10));
          medium = Math.max(low, Number(dist.p50));
          high = Math.max(medium, Number(dist.p90));
        }
      } catch (statsError) {
        // getFeeStats is best-effort — an idle/testnet RPC may return thin
        // or empty distributions. Fall back to the base-fee ladder, still
        // scaled by observed ledger cadence below.
        logger.warn(
          "feeEstimator: getFeeStats unavailable, using base-fee fallback",
          { error: (statsError as Error).message }
        );
      }

      this.snapshot = {
        low: Math.round(low * congestionMultiplier),
        medium: Math.round(medium * congestionMultiplier),
        high: Math.round(high * congestionMultiplier),
        latestLedger: latestLedger.sequence,
        updatedAt: Date.now(),
        isFallback: false,
      };
    } catch (error) {
      logger.error("feeEstimator: failed to refresh fee recommendation", {
        error: (error as Error).message,
      });
      // Keep serving the last known-good snapshot — a transient RPC outage
      // shouldn't block callers or reset them to stale defaults.
    }

    return this.snapshot;
  }

  /**
   * Derives a congestion multiplier from how quickly ledgers are closing
   * between successive polls. Ledgers closing slower than the ~5s Stellar
   * target imply the network is busier, so recommendations scale up
   * (capped at {@link MAX_CONGESTION_MULTIPLIER}); a normal-or-faster
   * cadence keeps the multiplier at 1.
   */
  private observeLedgerCadence(sequence: number): number {
    const now = Date.now();
    let multiplier = 1;

    if (
      this.lastLedgerSeq !== null &&
      this.lastLedgerSeenAt !== null &&
      sequence > this.lastLedgerSeq
    ) {
      const ledgersElapsed = sequence - this.lastLedgerSeq;
      const msElapsed = now - this.lastLedgerSeenAt;
      const msPerLedger = msElapsed / ledgersElapsed;
      multiplier = Math.min(
        MAX_CONGESTION_MULTIPLIER,
        Math.max(1, msPerLedger / EXPECTED_LEDGER_INTERVAL_MS)
      );
    }

    this.lastLedgerSeq = sequence;
    this.lastLedgerSeenAt = now;
    return multiplier;
  }
}

const config = loadConfig();
export const feeEstimator = new FeeEstimatorService(
  new RpcFailoverManager(config.sorobanRpcUrls)
);
