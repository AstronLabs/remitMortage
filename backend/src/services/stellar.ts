import { Horizon, StrKey } from "@stellar/stellar-sdk";
import { loadConfig, type StellarNetwork } from "../config.js";

/** Horizon caps a single operations page at 200 records. */
export const PAGE_LIMIT = 200;

const HORIZON_URL_DEFAULTS: Record<StellarNetwork, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  mainnet: "https://horizon.stellar.org",
  futurenet: "https://horizon-futurenet.stellar.org",
  standalone: "http://localhost:8000",
};

/**
 * Creates a Horizon server instance for the given URL, falling back to the
 * canonical URL for the supplied network when `horizonUrl` is empty.
 */
export function createHorizonServer(
  horizonUrl: string,
  network: StellarNetwork = "testnet"
): HorizonServerLike {
  const url = horizonUrl || HORIZON_URL_DEFAULTS[network];
  return new Horizon.Server(url) as unknown as HorizonServerLike;
}

const _config = loadConfig();
const defaultServer = createHorizonServer(_config.horizonUrl, _config.stellarNetwork);

/**
 * Minimal structural view of the Horizon objects this service depends on,
 * so the pagination/analysis logic can be unit-tested with a mock server.
 */
export interface HorizonOperation {
  type: string;
  from?: string;
  to?: string;
  asset_code?: string;
  asset_type?: string;
  amount?: string;
  created_at: string;
}

export interface OperationsPageLike {
  records: HorizonOperation[];
  next: () => Promise<OperationsPageLike>;
}

export interface HorizonServerLike {
  operations: () => {
    forAccount: (account: string) => {
      limit: (n: number) => {
        order: (dir: "asc" | "desc") => {
          call: () => Promise<OperationsPageLike>;
        };
      };
    };
  };
}

const defaultServer = new Horizon.Server(
  config.horizonUrl
) as unknown as HorizonServerLike;

export interface PaymentStats {
  totalPayments: number;
  totalAmountUSDC: string;
  averageAmountUSDC: string;
  standardDeviation: number;
  firstPayment: string | null;
  lastPayment: string | null;
  spanMonths: number;
}

export interface RemittanceAnalysis extends PaymentStats {
  senderAddress: string;
  recipientAddress: string;
  selfDealing: boolean;
  eligible: boolean;
  reason: string;
}

export interface AnalyzeOptions {
  /** Injectable Horizon server (defaults to the configured testnet/mainnet server). */
  server?: HorizonServerLike;
  /**
   * Additional wallet addresses known to belong to the same borrower. If the
   * recipient routes USDC to any of these (or back to the sender), the history
   * is treated as self-dealing.
   */
  borrowerWallets?: string[];
}

/** Thrown when an address is not a valid Stellar public (G...) key. */
export class InvalidStellarAddressError extends Error {
  constructor(public readonly address: string) {
    super(`Invalid Stellar address: ${address}`);
    this.name = "InvalidStellarAddressError";
  }
}

function assertValidAddress(address: string): void {
  if (!StrKey.isValidEd25519PublicKey(address)) {
    throw new InvalidStellarAddressError(address);
  }
}

/**
 * Fetches the complete operation history for an account, following Horizon's
 * `next` page cursors until the history is exhausted. Horizon returns at most
 * {@link PAGE_LIMIT} records per page, so accounts with longer histories
 * require recursive pagination.
 */
export async function fetchAllOperations(
  account: string,
  server: HorizonServerLike = defaultServer
): Promise<HorizonOperation[]> {
  const all: HorizonOperation[] = [];

  let page = await server
    .operations()
    .forAccount(account)
    .limit(PAGE_LIMIT)
    .order("asc")
    .call();

  while (page.records.length > 0) {
    all.push(...page.records);

    // A short page means we've reached the end of the history.
    if (page.records.length < PAGE_LIMIT) {
      break;
    }

    page = await page.next();
  }

  return all;
}

function isUsdcPayment(op: HorizonOperation): boolean {
  return op.type === "payment" && op.asset_code === "USDC";
}

/**
 * Computes remittance statistics (totals, average, standard deviation, and the
 * timespan in months) over a set of payments. Pure and side-effect free so the
 * average/timespan math can be unit-tested in isolation.
 */
export function summarizePayments(
  payments: Array<{ amount: string; date: string }>
): PaymentStats {
  if (payments.length === 0) {
    return {
      totalPayments: 0,
      totalAmountUSDC: "0",
      averageAmountUSDC: "0",
      standardDeviation: 0,
      firstPayment: null,
      lastPayment: null,
      spanMonths: 0,
    };
  }

  // Sort oldest first.
  const sorted = [...payments].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  const totalAmount = sorted.reduce((sum, p) => sum + parseFloat(p.amount), 0);
  const avgAmount = totalAmount / sorted.length;

  const variance =
    sorted.reduce(
      (sum, p) => sum + Math.pow(parseFloat(p.amount) - avgAmount, 2),
      0
    ) / sorted.length;
  const standardDeviation = Math.sqrt(variance);

  const firstDate = new Date(sorted[0].date);
  const lastDate = new Date(sorted[sorted.length - 1].date);
  const spanMonths = Math.round(
    (lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24 * 30)
  );

  return {
    totalPayments: sorted.length,
    totalAmountUSDC: totalAmount.toFixed(2),
    averageAmountUSDC: avgAmount.toFixed(2),
    standardDeviation,
    firstPayment: sorted[0].date,
    lastPayment: sorted[sorted.length - 1].date,
    spanMonths,
  };
}

/**
 * Inspects the recipient's outgoing payments for self-dealing: USDC routed
 * back to the sender (a circular Sender → Recipient → Sender transfer) or
 * forwarded to any other wallet known to belong to the same borrower.
 */
export function detectSelfDealing(
  recipientOps: HorizonOperation[],
  recipientAddress: string,
  flaggedWallets: Set<string>
): boolean {
  return recipientOps.some(
    (op) =>
      isUsdcPayment(op) &&
      op.from === recipientAddress &&
      typeof op.to === "string" &&
      flaggedWallets.has(op.to)
  );
}

/**
 * Queries Stellar Horizon for outgoing USDC payments from sender to recipient
 * across the full (paginated) history and analyzes the pattern for remittance
 * consistency, rejecting self-dealing/circular transfer patterns.
 */
export async function analyzeRemittanceHistory(
  senderAddress: string,
  recipientAddress: string,
  options: AnalyzeOptions = {}
): Promise<RemittanceAnalysis> {
  assertValidAddress(senderAddress);
  assertValidAddress(recipientAddress);

  const server = options.server ?? defaultServer;

  const base = {
    senderAddress,
    recipientAddress,
  };

  let senderOps: HorizonOperation[];
  let recipientOps: HorizonOperation[];
  try {
    // Fetch the complete history for both accounts (recursively paginated).
    [senderOps, recipientOps] = await Promise.all([
      fetchAllOperations(senderAddress, server),
      fetchAllOperations(recipientAddress, server),
    ]);
  } catch (error) {
    console.error("Horizon query error:", error);
    return {
      ...base,
      ...summarizePayments([]),
      selfDealing: false,
      eligible: false,
      reason: "Failed to query Stellar Horizon",
    };
  }

  // Self-dealing: recipient returning funds to the sender or to other wallets
  // owned by the same borrower.
  const flaggedWallets = new Set<string>([
    senderAddress,
    ...(options.borrowerWallets ?? []),
  ]);
  const selfDealing = detectSelfDealing(
    recipientOps,
    recipientAddress,
    flaggedWallets
  );

  // Outgoing USDC payments from sender to recipient.
  const payments = senderOps
    .filter(
      (op) => isUsdcPayment(op) && op.from === senderAddress && op.to === recipientAddress
    )
    .map((op) => ({ amount: op.amount ?? "0", date: op.created_at }));

  const stats = summarizePayments(payments);

  if (selfDealing) {
    return {
      ...base,
      ...stats,
      selfDealing: true,
      eligible: false,
      reason:
        "Self-dealing detected: recipient routes funds back to the sender (circular transfer)",
    };
  }

  if (payments.length === 0) {
    return {
      ...base,
      ...stats,
      selfDealing: false,
      eligible: false,
      reason: "No USDC payments found to recipient",
    };
  }

  // Eligibility: at least 6 payments over at least 3 months.
  const eligible = stats.totalPayments >= 6 && stats.spanMonths >= 3;

  return {
    ...base,
    ...stats,
    selfDealing: false,
    eligible,
    reason: eligible
      ? "Meets minimum remittance consistency requirements"
      : `Insufficient history: ${stats.totalPayments} payments over ${stats.spanMonths} months (need ≥6 payments over ≥3 months)`,
  };
}
