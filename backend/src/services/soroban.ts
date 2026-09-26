// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { loadConfig } from "../config.js";
import { RpcFailoverManager } from "./rpcFailover.js";
import logger from "../utils/logger.js";

const config = loadConfig();

/** Network passphrase derived from the configured Stellar network. */
const networkPassphrase =
  config.stellarNetwork === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

/**
 * RPC failover manager for automatic load balancing and failover across
 * multiple Soroban RPC nodes.
 */
const rpcManager = new RpcFailoverManager(config.sorobanRpcUrls);

/**
 * Soroban RPC server used to simulate read-only contract calls. The server
 * exposes on-chain state without requiring any account to sign or pay fees.
 * 
 * @deprecated Use rpcManager.execute() for automatic failover support
 */
const server = new rpc.Server(config.sorobanRpcUrl, {
  allowHttp: config.sorobanRpcUrl.startsWith("http://"),
});

/**
 * Dummy source account used only to build the transaction envelope that gets
 * simulated. Read-only simulations never touch this account's sequence or
 * balance, so a well-known all-zero public key is sufficient.
 */
const SIMULATION_SOURCE =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** Default goal identifier used when a borrower goal is not specified. */
export const DEFAULT_GOAL_ID = "default";

// ---------------------------------------------------------------------------
// In-memory cache (30-second TTL)
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

/**
 * Returns a cached value for `key` when still fresh, otherwise runs `loader`,
 * caches its result for the TTL window, and returns it. This collapses
 * repeated reads of the same on-chain state into a single RPC round-trip.
 */
async function withCache<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value as T;
  }

  const value = await loader();
  cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

/** Clears the query cache. Primarily useful for tests. */
export function clearSorobanCache(): void {
  cache.clear();
}

/** Raised when a contract simulation fails or returns an error result. */
export class SorobanQueryError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SorobanQueryError";
  }
}

// ---------------------------------------------------------------------------
// Simulation helper
// ---------------------------------------------------------------------------

/**
 * Simulates a read-only contract invocation and returns the decoded native
 * value. No keypair is required — the transaction is built against a dummy
 * source account and never submitted, so nothing is signed or charged.
 *
 * Uses automatic RPC failover for resilience against node outages.
 *
 * @throws SorobanQueryError when the contract id is unset, the RPC call fails,
 *   or the contract returns an error.
 */
async function simulateRead(
  contractId: string,
  method: string,
  ...args: xdr.ScVal[]
): Promise<unknown> {
  if (!contractId) {
    throw new SorobanQueryError(
      `Contract id is not configured for method "${method}"`
    );
  }

  const contract = new Contract(contractId);
  const source = new Account(SIMULATION_SOURCE, "0");
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const result = await rpcManager.execute(
    async (rpcServer) => {
      return await rpcServer.simulateTransaction(tx);
    },
    `simulateRead:${method}`
  );

  if (rpc.Api.isSimulationError(result)) {
    throw new SorobanQueryError(
      `Contract returned an error for ${method}: ${result.error}`
    );
  }

  const retval = result.result?.retval;
  if (!retval) {
    throw new SorobanQueryError(`No return value from ${method}`);
  }

  return scValToNative(retval);
}

/** Encodes a Stellar address argument as an ScVal. */
function addrArg(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}

/** Encodes a Soroban Symbol argument (used for goal ids). */
function symbolArg(value: string): xdr.ScVal {
  return nativeToScVal(value, { type: "symbol" });
}

/** Encodes a 32-byte loan id (hex string) as a BytesN<32> argument. */
function loanIdArg(loanId: string): xdr.ScVal {
  const buf = Buffer.from(loanId.replace(/^0x/, ""), "hex");
  if (buf.length !== 32) {
    throw new SorobanQueryError(
      "loanId must be a 32-byte hex string (64 hex characters)"
    );
  }
  return nativeToScVal(buf, { type: "bytes" });
}

// ---------------------------------------------------------------------------
// Escrow contract queries
// ---------------------------------------------------------------------------

export interface EscrowConfig {
  admin: string;
  token: string;
  savings_target: string;
  max_duration_ledgers: number;
  early_withdrawal_penalty_bps: number;
  min_duration_ledgers: number;
  penalty_bps_tier1: number;
  penalty_bps_tier2: number;
  penalty_bps_tier3: number;
  penalty_bps_tier4: number;
  grace_period_ledgers: number;
  default_penalty_bps: number;
}

export interface BorrowerBalance {
  deposited: string;
  start_ledger: number;
  released: boolean;
  withdrawn: boolean;
  last_contribution_ledger: number;
  target_amount: string;
}

/** Returns the escrow contract configuration (admin, token, penalty config). */
export async function getEscrowConfig(
  contractId: string
): Promise<EscrowConfig> {
  return withCache(`escrow:config:${contractId}`, async () => {
    const raw = (await simulateRead(contractId, "get_escrow_config")) as Record<
      string,
      unknown
    >;
    return normalizeBigInts(raw) as EscrowConfig;
  });
}

/**
 * Returns a borrower's escrow record (deposited amount, start ledger, status).
 * The escrow contract keys records by borrower address and goal id; `goalId`
 * defaults to {@link DEFAULT_GOAL_ID}.
 */
export async function getBorrowerBalance(
  contractId: string,
  borrowerAddress: string,
  goalId: string = DEFAULT_GOAL_ID
): Promise<BorrowerBalance> {
  return withCache(
    `escrow:borrower:${contractId}:${borrowerAddress}:${goalId}`,
    async () => {
      const raw = (await simulateRead(
        contractId,
        "get_borrower_info",
        addrArg(borrowerAddress),
        symbolArg(goalId)
      )) as Record<string, unknown>;
      return normalizeBigInts(raw) as BorrowerBalance;
    }
  );
}

/** Returns the total escrowed USDC pooled across all borrowers. */
export async function getTotalPooled(contractId: string): Promise<string> {
  return withCache(`escrow:total:${contractId}`, async () => {
    const total = await simulateRead(contractId, "get_total_pooled");
    return String(total);
  });
}

// ---------------------------------------------------------------------------
// Lending pool contract queries
// ---------------------------------------------------------------------------

export interface LoanInfo {
  borrower: string;
  principal: string;
  disbursed: string;
  repaid: string;
  interest_rate_bps: number;
  status: string;
  created_ledger: number;
  last_interest_ledger: number;
  outstanding_debt: string;
  escrow_origin: string | null;
}

export interface InvestorInfo {
  deposited: string;
  claimed_yield: string;
  start_ledger: number;
  tranche: string;
  accrued_yield: string;
  absorbed_loss: string;
}

/** On-chain lending-pool configuration — the authoritative rate registry. */
export interface PoolConfig {
  admin: string;
  token: string;
  escrow: string;
  /** Annual borrower interest rate in basis points (e.g. 800 = 8%). */
  interest_rate_bps: number;
  /** Fixed annual yield paid to the senior tranche, in basis points. */
  senior_rate_bps: number;
  treasury_address: string;
}

/** Returns the lending pool's currently available liquidity. */
export async function getPoolLiquidity(contractId: string): Promise<string> {
  return withCache(`pool:liquidity:${contractId}`, async () => {
    const liquidity = await simulateRead(contractId, "get_liquidity");
    return String(liquidity);
  });
}

/** Returns the lending pool's on-chain configuration (rates, admin, token). */
export async function getPoolConfig(contractId: string): Promise<PoolConfig> {
  return withCache(`pool:config:${contractId}`, async () => {
    const raw = (await simulateRead(contractId, "get_pool_config")) as Record<
      string,
      unknown
    >;
    return normalizeBigInts(raw) as PoolConfig;
  });
}

/** Returns total capital currently deposited into the senior tranche. */
export async function getSeniorLiquidity(contractId: string): Promise<string> {
  return withCache(`pool:senior_liquidity:${contractId}`, async () => {
    const liquidity = await simulateRead(contractId, "get_senior_liquidity");
    return String(liquidity);
  });
}

/** Returns total capital currently deposited into the junior tranche. */
export async function getJuniorLiquidity(contractId: string): Promise<string> {
  return withCache(`pool:junior_liquidity:${contractId}`, async () => {
    const liquidity = await simulateRead(contractId, "get_junior_liquidity");
    return String(liquidity);
  });
}

export interface LendingPoolRates {
  /** Base annual borrower rate from the pool config (bps). */
  poolApyBps: number;
  /** Fixed annual senior-tranche yield straight from the pool config (bps). */
  seniorApyBps: number;
  /**
   * Estimated annual junior-tranche yield (bps): the residual interest budget
   * left over after paying the senior tranche its fixed rate, spread across
   * junior liquidity. Mirrors the pool contract's own residual-yield split
   * (see `lending-pool/src/lib.rs`, senior/junior yield distribution).
   */
  juniorApyBps: number;
  seniorLiquidity: string;
  juniorLiquidity: string;
}

/**
 * Pure calculation: the junior tranche absorbs whatever annual interest is
 * left over after the senior tranche is paid its fixed rate, spread across
 * junior liquidity. Mirrors the pool contract's own residual-yield split
 * (see `lending-pool/src/lib.rs`, senior/junior yield distribution).
 * Exported standalone so the formula is unit-testable without an RPC round-trip.
 */
export function computeJuniorApyBps(
  poolApyBps: number,
  seniorApyBps: number,
  seniorLiquidity: number,
  juniorLiquidity: number
): number {
  const totalDeposited = seniorLiquidity + juniorLiquidity;
  if (juniorLiquidity <= 0 || totalDeposited <= 0) return 0;

  const totalInterestBudget = poolApyBps * totalDeposited;
  const seniorCost = seniorApyBps * seniorLiquidity;
  return Math.max(0, Math.round((totalInterestBudget - seniorCost) / juniorLiquidity));
}

/**
 * Computes live senior/junior APY figures from the deployed lending-pool
 * contract — the "active registry" of protocol interest rates — instead of
 * a hardcoded estimate.
 */
export async function getLendingPoolRates(
  contractId: string
): Promise<LendingPoolRates> {
  const [config, seniorLiquidity, juniorLiquidity] = await Promise.all([
    getPoolConfig(contractId),
    getSeniorLiquidity(contractId),
    getJuniorLiquidity(contractId),
  ]);

  const poolApyBps = config.interest_rate_bps;
  const seniorApyBps = config.senior_rate_bps;
  const juniorApyBps = computeJuniorApyBps(
    poolApyBps,
    seniorApyBps,
    Number(seniorLiquidity),
    Number(juniorLiquidity)
  );

  return { poolApyBps, seniorApyBps, juniorApyBps, seniorLiquidity, juniorLiquidity };
}

/**
 * Returns a loan record (principal, disbursed, repaid, status). `loanId` is the
 * 32-byte loan id as a hex string.
 */
export async function getLoanInfo(
  contractId: string,
  loanId: string
): Promise<LoanInfo> {
  return withCache(`pool:loan:${contractId}:${loanId}`, async () => {
    const raw = (await simulateRead(
      contractId,
      "get_loan_info",
      loanIdArg(loanId)
    )) as Record<string, unknown>;
    return normalizeBigInts(raw) as LoanInfo;
  });
}

/** Returns an investor's deposit record. */
export async function getInvestorInfo(
  contractId: string,
  investorAddress: string
): Promise<InvestorInfo> {
  return withCache(
    `pool:investor:${contractId}:${investorAddress}`,
    async () => {
      const raw = (await simulateRead(
        contractId,
        "get_investor_info",
        addrArg(investorAddress)
      )) as Record<string, unknown>;
      return normalizeBigInts(raw) as InvestorInfo;
    }
  );
}

/**
 * Recursively converts BigInt values (returned by scValToNative for i128/u64)
 * into strings so the result is JSON-serializable without precision loss.
 */
function normalizeBigInts(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeBigInts);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeBigInts(v);
    }
    return out;
  }
  return value;
}
