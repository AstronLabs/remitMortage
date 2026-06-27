/**
 * Protocol analytics service.
 *
 * Aggregates protocol metrics from on-chain-synced state (the borrower balance
 * store populated by the Soroban event listener) and off-chain records (loan
 * applications and milestone proposals) into dashboard-ready figures.
 *
 * The calculation functions (`compute*`) are pure and operate on a
 * {@link ProtocolSnapshot}, so they can be unit-tested with mock data. The
 * public `get*` functions gather a live snapshot from the stores and cache the
 * result for {@link CACHE_TTL_MS} to avoid excessive RPC/database work.
 */

import { listApplications, type LoanStatus } from "./loanStore.js";
import { balanceRepository } from "./balanceStore.js";
import { listProposals, type MilestoneProposalStatus } from "./milestoneProposalStore.js";

// ── Money helpers ──────────────────────────────────────────────────────────

/** USDC has 7 decimals on Stellar (stroops). */
const STROOPS_PER_UNIT = 10_000_000;

/** Sums a list of integer stroop decimal strings, returning a decimal string. */
function sumStroops(values: string[]): string {
  return values.reduce((acc, v) => acc + safeBigInt(v), 0n).toString();
}

/** Parses a stroop string to BigInt, tolerating empty/invalid input as 0. */
function safeBigInt(value: string | null | undefined): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/** Converts a USDC amount string (e.g. "5000.5") to integer stroops. */
function usdcToStroops(usdc: string): string {
  const num = Number(usdc);
  if (!Number.isFinite(num) || num <= 0) return "0";
  return BigInt(Math.round(num * STROOPS_PER_UNIT)).toString();
}

/** Rounds a ratio to a percentage with two decimals. */
function toPercent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10000) / 100;
}

// ── Snapshot shape ─────────────────────────────────────────────────────────

export interface AnalyticsLoan {
  borrowerAddress: string;
  status: LoanStatus;
  /** Loan amount in USDC (as stored by the loan application store). */
  amount: string;
  createdAt: string;
}

export interface AnalyticsBalance {
  address: string;
  /** Escrow savings in stroops. */
  escrowBalance: string;
  /** Outstanding disbursed loan principal in stroops. */
  loanOutstanding: string;
}

export interface AnalyticsMilestone {
  status: MilestoneProposalStatus;
  createdAt: string;
  updatedAt: string;
}

export type VolumeKind = "deposit" | "repayment" | "disbursement";

export interface VolumeEvent {
  kind: VolumeKind;
  /** Amount in stroops. */
  amount: string;
  /** ISO timestamp. */
  timestamp: string;
}

/** All raw inputs the analytics calculations operate on. */
export interface ProtocolSnapshot {
  loans: AnalyticsLoan[];
  balances: AnalyticsBalance[];
  milestones: AnalyticsMilestone[];
  /** Distinct investor count (from lending-pool records); 0 when unavailable. */
  investorCount: number;
  /** Defaulted-loan count from on-chain pool health; 0 when unavailable. */
  defaultedLoans: number;
  /** On-time installments observed (when repayment-schedule data is available). */
  onTimePayments: number;
  /** Total installments due (denominator for the on-time percentage). */
  totalScheduledPayments: number;
  /** Timestamped monetary events for the monthly volume chart. */
  volumeEvents: VolumeEvent[];
}

// ── Output shapes ──────────────────────────────────────────────────────────

export interface ProtocolOverview {
  tvl: { escrow: string; lendingPool: string; total: string };
  totalBorrowers: number;
  totalInvestors: number;
  totalLoans: number;
}

export interface LoanPerformance {
  activeLoans: number;
  repaidLoans: number;
  defaultedLoans: number;
  totalLoans: number;
  /** Share of concluded loans that were fully repaid, as a percentage. */
  repaymentRate: number;
  /** Share of concluded loans that defaulted, as a percentage. */
  defaultRate: number;
  /** Share of due installments paid on time, as a percentage. */
  onTimePaymentPercentage: number;
}

export interface DisbursementProgress {
  totalDisbursed: string;
  milestonesCompleted: number;
  milestonesPending: number;
  /** Average wall-clock time to complete a milestone, in milliseconds. */
  averageMilestoneCompletionMs: number;
}

export interface MonthlyVolumePoint {
  /** Calendar month in `YYYY-MM` form. */
  month: string;
  deposits: string;
  repayments: string;
  disbursements: string;
}

const ACTIVE_STATUSES: ReadonlySet<LoanStatus> = new Set<LoanStatus>([
  "Approved",
  "Disbursing",
  "Repaying",
]);
const FUNDED_STATUSES: ReadonlySet<LoanStatus> = new Set<LoanStatus>([
  "Disbursing",
  "Repaying",
  "Completed",
]);

// ── Pure calculations ──────────────────────────────────────────────────────

export function computeOverview(snapshot: ProtocolSnapshot): ProtocolOverview {
  const escrow = sumStroops(snapshot.balances.map((b) => b.escrowBalance));
  const lendingPool = sumStroops(snapshot.balances.map((b) => b.loanOutstanding));
  const total = sumStroops([escrow, lendingPool]);

  const borrowers = new Set<string>();
  for (const loan of snapshot.loans) borrowers.add(loan.borrowerAddress);
  for (const balance of snapshot.balances) borrowers.add(balance.address);

  return {
    tvl: { escrow, lendingPool, total },
    totalBorrowers: borrowers.size,
    totalInvestors: snapshot.investorCount,
    totalLoans: snapshot.loans.length,
  };
}

export function computeLoanPerformance(snapshot: ProtocolSnapshot): LoanPerformance {
  let active = 0;
  let repaid = 0;
  for (const loan of snapshot.loans) {
    if (loan.status === "Completed") repaid += 1;
    else if (ACTIVE_STATUSES.has(loan.status)) active += 1;
  }

  const defaulted = snapshot.defaultedLoans;
  const concluded = repaid + defaulted;

  return {
    activeLoans: active,
    repaidLoans: repaid,
    defaultedLoans: defaulted,
    totalLoans: snapshot.loans.length,
    repaymentRate: toPercent(repaid, concluded),
    defaultRate: toPercent(defaulted, concluded),
    onTimePaymentPercentage: toPercent(
      snapshot.onTimePayments,
      snapshot.totalScheduledPayments
    ),
  };
}

export function computeDisbursementProgress(
  snapshot: ProtocolSnapshot
): DisbursementProgress {
  const totalDisbursed = sumStroops(
    snapshot.balances.map((b) => b.loanOutstanding)
  );

  let completed = 0;
  let pending = 0;
  let totalDurationMs = 0;
  for (const milestone of snapshot.milestones) {
    if (milestone.status === "Passed") {
      completed += 1;
      const elapsed =
        new Date(milestone.updatedAt).getTime() -
        new Date(milestone.createdAt).getTime();
      if (Number.isFinite(elapsed) && elapsed > 0) totalDurationMs += elapsed;
    } else if (milestone.status === "Open") {
      pending += 1;
    }
  }

  return {
    totalDisbursed,
    milestonesCompleted: completed,
    milestonesPending: pending,
    averageMilestoneCompletionMs:
      completed > 0 ? Math.round(totalDurationMs / completed) : 0,
  };
}

export function computeMonthlyVolume(
  events: VolumeEvent[],
  months: number,
  now: Date
): MonthlyVolumePoint[] {
  const clampedMonths = Math.min(Math.max(Math.trunc(months) || 0, 1), 24);

  // Build the ordered list of month keys (oldest first) ending at `now`.
  const buckets = new Map<string, { deposit: bigint; repayment: bigint; disbursement: bigint }>();
  const order: string[] = [];
  for (let i = clampedMonths - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = monthKey(d);
    order.push(key);
    buckets.set(key, { deposit: 0n, repayment: 0n, disbursement: 0n });
  }

  for (const event of events) {
    const ts = new Date(event.timestamp);
    if (Number.isNaN(ts.getTime())) continue;
    const key = monthKey(ts);
    const bucket = buckets.get(key);
    if (!bucket) continue; // outside the requested window
    bucket[event.kind] += safeBigInt(event.amount);
  }

  return order.map((month) => {
    const b = buckets.get(month)!;
    return {
      month,
      deposits: b.deposit.toString(),
      repayments: b.repayment.toString(),
      disbursements: b.disbursement.toString(),
    };
  });
}

/** Formats a date as a `YYYY-MM` UTC month key. */
function monthKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

// ── Snapshot gathering ─────────────────────────────────────────────────────

/** Injectable data sources, overridable in tests. */
export interface AnalyticsDeps {
  listLoans?: () => AnalyticsLoan[];
  listBalances?: () => AnalyticsBalance[];
  listMilestones?: () => AnalyticsMilestone[];
  investorCount?: number;
  defaultedLoans?: number;
  onTimePayments?: number;
  totalScheduledPayments?: number;
  now?: () => Date;
}

function defaultLoans(): AnalyticsLoan[] {
  return listApplications().map((a) => ({
    borrowerAddress: a.borrowerAddress,
    status: a.status,
    amount: a.amount,
    createdAt: a.createdAt,
  }));
}

function defaultBalances(): AnalyticsBalance[] {
  return balanceRepository.list().map((b) => ({
    address: b.address,
    escrowBalance: b.escrowBalance,
    loanOutstanding: b.loanOutstanding,
  }));
}

function defaultMilestones(): AnalyticsMilestone[] {
  return listProposals().map((p) => ({
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));
}

/** Gathers a live snapshot from the stores (or injected sources). */
export function gatherSnapshot(deps: AnalyticsDeps = {}): ProtocolSnapshot {
  const loans = (deps.listLoans ?? defaultLoans)();
  const balances = (deps.listBalances ?? defaultBalances)();
  const milestones = (deps.listMilestones ?? defaultMilestones)();

  // Derive disbursement volume events from funded loans (the only off-chain
  // records that carry both an amount and a timestamp).
  const volumeEvents: VolumeEvent[] = loans
    .filter((l) => FUNDED_STATUSES.has(l.status))
    .map((l) => ({
      kind: "disbursement" as const,
      amount: usdcToStroops(l.amount),
      timestamp: l.createdAt,
    }));

  return {
    loans,
    balances,
    milestones,
    investorCount: deps.investorCount ?? 0,
    defaultedLoans: deps.defaultedLoans ?? 0,
    onTimePayments: deps.onTimePayments ?? 0,
    totalScheduledPayments: deps.totalScheduledPayments ?? 0,
    volumeEvents,
  };
}

// ── 60-second response cache ─────────────────────────────────────────────────

export const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function withCache<T>(key: string, loader: () => T): T {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;
  const value = loader();
  cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

/** Clears the analytics cache. Primarily for tests. */
export function clearAnalyticsCache(): void {
  cache.clear();
}

// ── Public, cached API ───────────────────────────────────────────────────────

export function getProtocolOverview(deps?: AnalyticsDeps): ProtocolOverview {
  return withCache("overview", () => computeOverview(gatherSnapshot(deps)));
}

export function getLoanPerformance(deps?: AnalyticsDeps): LoanPerformance {
  return withCache("loans", () => computeLoanPerformance(gatherSnapshot(deps)));
}

export function getDisbursementProgress(deps?: AnalyticsDeps): DisbursementProgress {
  return withCache("disbursement", () =>
    computeDisbursementProgress(gatherSnapshot(deps))
  );
}

export function getMonthlyVolume(months: number, deps?: AnalyticsDeps): MonthlyVolumePoint[] {
  const clamped = Math.min(Math.max(Math.trunc(months) || 0, 1), 24);
  const now = deps?.now?.() ?? new Date();
  return withCache(`volume:${clamped}`, () =>
    computeMonthlyVolume(gatherSnapshot(deps).volumeEvents, clamped, now)
  );
}
