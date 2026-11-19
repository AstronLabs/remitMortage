// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Plain-language transaction preview shown before the wallet prompt (issue #884).
 *
 * Freighter shows an XDR. Nobody reads an XDR. So a user approving a
 * transaction is, in practice, trusting that the app built what the form said —
 * which is exactly the assumption a malicious or buggy build breaks.
 *
 * This module removes that assumption. It reads the **envelope that is about to
 * be signed** — operations, contract, function name, decoded arguments — and
 * describes it in a sentence, then cross-checks that description against what
 * the user actually asked for. A mismatch between the two is reported as a
 * warning, because the envelope is the thing that will execute.
 *
 * Two distinct outcomes, deliberately not conflated:
 *
 * - **`ok: false`** — the simulation failed or the envelope could not be
 *   parsed. The signing prompt must not open at all: there is nothing
 *   trustworthy to show, and submitting would burn a fee on a transaction that
 *   cannot succeed.
 * - **`requiresAcknowledgement: true`** — the preview is trustworthy and says
 *   something alarming (an amount that does not match the form, an unexpected
 *   recipient, an unrecognised contract call, a change to who can sign for the
 *   account). The user may legitimately proceed — an early-withdrawal penalty
 *   is a real choice — but only after an explicit acknowledgement.
 *
 * Everything here is pure. `lib/soroban-client.ts` supplies the parsed envelope
 * and the simulation outcome; this file decides what the user is told.
 */

import { feeToUsd, formatFee } from "./gas-fees";

/** USDC and XLM both use 7 decimal places on Stellar. */
const STROOPS_PER_UNIT = 10_000_000;

/**
 * Fee above which the preview says so, in stroops (0.5 XLM). A Soroban
 * resource fee of a few hundred thousand stroops is normal; half an XLM for an
 * escrow deposit is not, and is usually a sign of a bad override.
 */
export const HIGH_FEE_STROOPS = 5_000_000;

export type TransactionKind =
  | "escrow_deposit"
  | "escrow_withdraw"
  | "loan_repayment"
  | "milestone_approval"
  | "multisig_setup"
  | "token_transfer"
  | "unknown";

/** Human labels for the transaction types this app builds. */
export const TRANSACTION_KIND_LABELS: Record<TransactionKind, string> = {
  escrow_deposit: "Escrow deposit",
  escrow_withdraw: "Escrow withdrawal",
  loan_repayment: "Loan repayment",
  milestone_approval: "Milestone approval",
  multisig_setup: "Signing policy change",
  token_transfer: "Token transfer",
  unknown: "Unrecognised transaction",
};

/** One decoded operation from the envelope that is about to be signed. */
export interface ParsedOperation {
  /** Stellar operation type, e.g. `invokeHostFunction`, `payment`, `setOptions`. */
  type: string;
  /** Soroban: the contract being invoked. */
  contractId?: string;
  /** Soroban: the function name. */
  functionName?: string;
  /** Soroban: arguments, decoded to natives and stringified. */
  args?: string[];
  /** Classic payment: destination account. */
  destination?: string;
  /** Classic payment: amount, as a decimal string. */
  amount?: string;
  /** Classic payment: asset code. */
  assetCode?: string;
  /** setOptions: signer additions/removals. */
  signers?: Array<{ key: string; weight: number }>;
  /** setOptions: thresholds and master weight. */
  thresholds?: {
    masterWeight?: number;
    low?: number;
    medium?: number;
    high?: number;
  };
}

/** The envelope, decoded. Produced by `parseTransactionEnvelope` in soroban-client. */
export interface ParsedTransaction {
  /** Source account that pays the fee and authorises the operations. */
  source: string;
  /** Total fee cap in stroops. */
  feeStroops: number;
  operations: ParsedOperation[];
}

/** Outcome of simulating the assembled transaction against Soroban RPC. */
export type SimulationOutcome =
  | { ok: true; minResourceFeeStroops?: number }
  | { ok: false; error: string };

/**
 * What the user asked for, from the form they filled in. Used only to
 * cross-check the envelope — never to describe it.
 */
export interface PreviewIntent {
  /** The connected wallet. A different envelope source is a red flag. */
  account: string;
  /** Decimal amount the user typed, e.g. "100.50". */
  amount?: string;
  /** Asset the user expects to move. Defaults to USDC. */
  asset?: string;
  /** Contracts/accounts the funds are expected to reach. */
  expectedRecipients?: string[];
  /** The user's available balance, for an insufficient-funds warning. */
  balance?: string;
  /** Early-withdrawal penalty in basis points, for a withdrawal. */
  penaltyBps?: number;
  /** Milestone or proposal id, for a governance approval. */
  referenceId?: string;
}

export type PreviewEffectKind =
  | "debit"
  | "credit"
  | "fee"
  | "authorization"
  | "account_policy"
  | "contract_call";

export interface TransactionEffect {
  kind: PreviewEffectKind;
  /** One plain-language line. No jargon, no hex. */
  text: string;
  /** Decimal amount, when the effect moves value. */
  amount?: string;
  asset?: string;
  counterparty?: string;
}

export type PreviewWarningCode =
  | "simulation_failed"
  | "unparseable_transaction"
  | "unknown_transaction"
  | "amount_mismatch"
  | "unexpected_recipient"
  | "unexpected_source"
  | "multiple_operations"
  | "no_operations"
  | "signer_policy_change"
  | "penalty_applied"
  | "balance_exceeded"
  | "high_fee";

export interface PreviewWarning {
  code: PreviewWarningCode;
  /** `danger` requires an explicit acknowledgement before signing. */
  severity: "info" | "warning" | "danger";
  text: string;
}

export interface TransactionPreview {
  kind: TransactionKind;
  /** The headline: what this transaction does, in one sentence. */
  summary: string;
  /** Line-by-line effects, derived from the envelope. */
  effects: TransactionEffect[];
  warnings: PreviewWarning[];
  fee: { stroops: number; label: string; usd: string | null };
  /**
   * False when the signing prompt must not open: the simulation failed, or the
   * envelope could not be decoded.
   */
  ok: boolean;
  /** Why `ok` is false, for the UI to show instead of the summary. */
  failureReason?: string;
  /** True when a `danger` warning needs the user to confirm explicitly. */
  requiresAcknowledgement: boolean;
}

/** Thrown instead of opening the wallet prompt when a preview is not `ok`. */
export class SimulationBlockedError extends Error {
  readonly preview: TransactionPreview;

  constructor(preview: TransactionPreview) {
    super(
      preview.failureReason ??
        "The transaction could not be simulated, so it was not sent to your wallet."
    );
    this.name = "SimulationBlockedError";
    this.preview = preview;
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** `GABCDEF…WXYZ` — enough to compare against a known address by eye. */
export function shortenAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/** Stroops to a decimal string with trailing zeros trimmed: `1005000000` → `100.5`. */
export function stroopsToDecimal(stroops: bigint | string | number): string {
  let value: bigint;
  try {
    value = typeof stroops === "bigint" ? stroops : BigInt(String(stroops).split(".")[0]);
  } catch {
    return "0";
  }

  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / BigInt(STROOPS_PER_UNIT);
  const fraction = (absolute % BigInt(STROOPS_PER_UNIT)).toString().padStart(7, "0").replace(/0+$/, "");

  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Normalises a decimal amount for comparison: `100.50` and `100.5` are equal. */
export function normalizeAmount(amount: string): string {
  const trimmed = amount.trim();
  if (!/^-?\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === ".") return trimmed;
  const [whole, fraction = ""] = trimmed.replace(/^-/, "").split(".");
  const sign = trimmed.startsWith("-") ? "-" : "";
  const cleanWhole = whole.replace(/^0+(?=\d)/, "") || "0";
  const cleanFraction = fraction.replace(/0+$/, "");
  return `${sign}${cleanWhole}${cleanFraction ? `.${cleanFraction}` : ""}`;
}

function amountsEqual(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return true;
  return normalizeAmount(a) === normalizeAmount(b);
}

/** Basis points as a percentage string: `500` → `5`. */
export function bpsToPercent(bps: number): string {
  return normalizeAmount((bps / 100).toFixed(2));
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Contract functions this app builds, mapped to the kind they represent. */
const FUNCTION_KINDS: Record<string, TransactionKind> = {
  deposit: "escrow_deposit",
  withdraw: "escrow_withdraw",
  repay: "loan_repayment",
  repay_loan: "loan_repayment",
  approve_milestone: "milestone_approval",
  approve_disbursement: "milestone_approval",
  transfer: "token_transfer",
};

/**
 * What kind of transaction the envelope is — read from the envelope, not from
 * what the caller claims it built.
 */
export function classifyTransaction(parsed: ParsedTransaction): TransactionKind {
  const operation = parsed.operations[0];
  if (!operation) return "unknown";

  if (operation.type === "setOptions") return "multisig_setup";
  if (operation.type === "payment" || operation.type === "pathPaymentStrictSend") {
    return "token_transfer";
  }
  if (operation.type === "invokeHostFunction" && operation.functionName) {
    return FUNCTION_KINDS[operation.functionName] ?? "unknown";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/** The i128 argument of a contract call, as a decimal amount. */
function amountArgument(operation: ParsedOperation): string | undefined {
  const args = operation.args ?? [];
  // The app's contract calls take the amount last, in stroops.
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (/^\d+$/.test(args[index])) return stroopsToDecimal(args[index]);
  }
  return undefined;
}

/** Every signer addition/removal across all setOptions operations. */
function collectSignerChanges(
  parsed: ParsedTransaction
): Array<{ key: string; weight: number }> {
  return parsed.operations.flatMap((operation) => operation.signers ?? []);
}

/** One line per threshold or master-weight change in the envelope. */
function describeThresholdChanges(parsed: ParsedTransaction): string[] {
  const lines: string[] = [];

  for (const operation of parsed.operations) {
    const thresholds = operation.thresholds;
    if (!thresholds) continue;

    const parts: string[] = [];
    if (thresholds.masterWeight !== undefined) {
      parts.push(`your own key's weight to ${thresholds.masterWeight}`);
    }
    if (thresholds.low !== undefined) parts.push(`low threshold to ${thresholds.low}`);
    if (thresholds.medium !== undefined) parts.push(`medium threshold to ${thresholds.medium}`);
    if (thresholds.high !== undefined) parts.push(`high threshold to ${thresholds.high}`);
    if (parts.length > 0) lines.push(`Sets ${parts.join(", ")}`);
  }

  return lines;
}

function describeEffects(
  kind: TransactionKind,
  parsed: ParsedTransaction,
  intent: PreviewIntent
): TransactionEffect[] {
  const operation = parsed.operations[0];
  if (!operation) return [];

  const asset = intent.asset ?? "USDC";
  const effects: TransactionEffect[] = [];

  switch (kind) {
    case "escrow_deposit": {
      const amount = amountArgument(operation);
      effects.push({
        kind: "debit",
        text: `${amount ?? "An unknown amount of"} ${asset} leaves your wallet`,
        amount,
        asset,
      });
      effects.push({
        kind: "credit",
        text: `Credited to your savings escrow (${shortenAddress(operation.contractId ?? "")})`,
        amount,
        asset,
        counterparty: operation.contractId,
      });
      break;
    }

    case "escrow_withdraw": {
      effects.push({
        kind: "credit",
        text: `Your escrow balance is returned to your wallet`,
        asset,
        counterparty: operation.contractId,
      });
      if (intent.penaltyBps && intent.penaltyBps > 0) {
        effects.push({
          kind: "debit",
          text: `An early-withdrawal penalty of ${bpsToPercent(
            intent.penaltyBps
          )}% is deducted before you receive the rest`,
          asset,
        });
      }
      break;
    }

    case "loan_repayment": {
      const amount = amountArgument(operation);
      effects.push({
        kind: "debit",
        text: `${amount ?? "An unknown amount of"} ${asset} leaves your wallet`,
        amount,
        asset,
      });
      effects.push({
        kind: "credit",
        text: `Applied to your loan at the lending pool (${shortenAddress(
          operation.contractId ?? ""
        )})`,
        amount,
        asset,
        counterparty: operation.contractId,
      });
      break;
    }

    case "milestone_approval": {
      effects.push({
        kind: "authorization",
        text: `Records your approval for milestone ${
          intent.referenceId ?? operation.args?.[0] ?? "(unspecified)"
        }`,
        counterparty: operation.contractId,
      });
      effects.push({
        kind: "debit",
        text: "No funds leave your wallet — only the network fee below",
      });
      break;
    }

    case "multisig_setup": {
      // A setup transaction is normally several setOptions operations — one
      // per signer plus one for the thresholds — so every operation counts.
      for (const signer of collectSignerChanges(parsed)) {
        effects.push({
          kind: "account_policy",
          text:
            signer.weight === 0
              ? `Removes ${shortenAddress(signer.key)} as a signer`
              : `Adds ${shortenAddress(signer.key)} as a signer with weight ${signer.weight}`,
          counterparty: signer.key,
        });
      }

      for (const text of describeThresholdChanges(parsed)) {
        effects.push({ kind: "account_policy", text });
      }
      break;
    }

    case "token_transfer": {
      effects.push({
        kind: "debit",
        text: `${operation.amount ?? "An unknown amount of"} ${
          operation.assetCode ?? asset
        } is sent to ${shortenAddress(operation.destination ?? "")}`,
        amount: operation.amount,
        asset: operation.assetCode ?? asset,
        counterparty: operation.destination,
      });
      break;
    }

    default: {
      effects.push({
        kind: "contract_call",
        text: operation.functionName
          ? `Calls ${operation.functionName}() on contract ${shortenAddress(
              operation.contractId ?? ""
            )} with ${operation.args?.length ?? 0} argument(s)`
          : `Performs a ${operation.type} operation`,
        counterparty: operation.contractId,
      });
      break;
    }
  }

  return effects;
}

function describeSummary(
  kind: TransactionKind,
  parsed: ParsedTransaction,
  intent: PreviewIntent
): string {
  const operation = parsed.operations[0];
  const asset = intent.asset ?? "USDC";

  switch (kind) {
    case "escrow_deposit": {
      const amount = amountArgument(operation!);
      return `Move ${amount ?? "funds"} ${asset} from your wallet into your savings escrow.`;
    }
    case "escrow_withdraw":
      return intent.penaltyBps && intent.penaltyBps > 0
        ? `Withdraw your escrow savings early, minus a ${bpsToPercent(
            intent.penaltyBps
          )}% penalty.`
        : "Withdraw your escrow savings back to your wallet.";
    case "loan_repayment": {
      const amount = amountArgument(operation!);
      return `Repay ${amount ?? "funds"} ${asset} toward your loan.`;
    }
    case "milestone_approval":
      return `Approve a milestone disbursement. No funds leave your wallet.`;
    case "multisig_setup": {
      const signerCount = collectSignerChanges(parsed).length;
      return `Change who can sign for ${shortenAddress(parsed.source)}${
        signerCount > 0 ? ` (${signerCount} signer change${signerCount === 1 ? "" : "s"})` : ""
      }.`;
    }
    case "token_transfer":
      return `Send ${operation?.amount ?? "funds"} ${
        operation?.assetCode ?? asset
      } to ${shortenAddress(operation?.destination ?? "")}.`;
    default:
      return operation?.functionName
        ? `This transaction calls ${operation.functionName}() on a contract RemitMortgage does not recognise.`
        : "RemitMortgage cannot describe what this transaction does.";
  }
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/** Kinds that should always be exactly one operation in this app. */
const SINGLE_OPERATION_KINDS: TransactionKind[] = [
  "escrow_deposit",
  "escrow_withdraw",
  "loan_repayment",
  "milestone_approval",
];

function collectWarnings(
  kind: TransactionKind,
  parsed: ParsedTransaction,
  intent: PreviewIntent
): PreviewWarning[] {
  const warnings: PreviewWarning[] = [];
  const operation = parsed.operations[0];

  if (!operation) {
    warnings.push({
      code: "no_operations",
      severity: "danger",
      text: "This transaction contains no operations — signing it would do nothing but pay a fee.",
    });
    return warnings;
  }

  if (kind === "unknown") {
    warnings.push({
      code: "unknown_transaction",
      severity: "danger",
      text: "RemitMortgage did not build this transaction and cannot say what it will do. Only approve it if you know exactly where it came from.",
    });
  }

  if (SINGLE_OPERATION_KINDS.includes(kind) && parsed.operations.length > 1) {
    warnings.push({
      code: "multiple_operations",
      severity: "danger",
      text: `This transaction bundles ${parsed.operations.length} operations. A ${TRANSACTION_KIND_LABELS[
        kind
      ].toLowerCase()} should contain exactly one.`,
    });
  }

  if (parsed.source && intent.account && parsed.source !== intent.account) {
    warnings.push({
      code: "unexpected_source",
      severity: "danger",
      text: `This transaction is signed by ${shortenAddress(
        parsed.source
      )}, not your connected wallet ${shortenAddress(intent.account)}.`,
    });
  }

  // The amount in the envelope is the amount that will move. If it disagrees
  // with the form, the form is not what you are about to approve.
  const envelopeAmount =
    kind === "token_transfer" ? operation.amount : amountArgument(operation);
  if (intent.amount !== undefined && !amountsEqual(envelopeAmount, intent.amount)) {
    warnings.push({
      code: "amount_mismatch",
      severity: "danger",
      text: `You entered ${normalizeAmount(intent.amount)} but this transaction moves ${
        envelopeAmount ? normalizeAmount(envelopeAmount) : "an amount that could not be read"
      }.`,
    });
  }

  const recipient = operation.contractId ?? operation.destination;
  if (intent.expectedRecipients && intent.expectedRecipients.length > 0 && recipient) {
    if (!intent.expectedRecipients.includes(recipient)) {
      warnings.push({
        code: "unexpected_recipient",
        severity: "danger",
        text: `Funds would go to ${shortenAddress(
          recipient
        )}, which is not a RemitMortgage contract.`,
      });
    }
  }

  if (kind === "multisig_setup") {
    warnings.push({
      code: "signer_policy_change",
      severity: "danger",
      text: "This changes who can move funds from the account. Approving it with the wrong signers or thresholds can lock you out permanently.",
    });
  }

  if (kind === "escrow_withdraw" && intent.penaltyBps && intent.penaltyBps > 0) {
    warnings.push({
      code: "penalty_applied",
      severity: "warning",
      text: `Withdrawing before your savings term ends costs ${bpsToPercent(
        intent.penaltyBps
      )}% of your balance.`,
    });
  }

  if (intent.amount !== undefined && intent.balance !== undefined) {
    const amount = Number(intent.amount);
    const balance = Number(intent.balance);
    if (Number.isFinite(amount) && Number.isFinite(balance) && amount > balance) {
      warnings.push({
        code: "balance_exceeded",
        severity: "warning",
        text: `This moves ${normalizeAmount(
          intent.amount
        )} but your balance is ${normalizeAmount(intent.balance)}.`,
      });
    }
  }

  if (parsed.feeStroops > HIGH_FEE_STROOPS) {
    warnings.push({
      code: "high_fee",
      severity: "warning",
      text: `The network fee is capped at ${formatFee(
        parsed.feeStroops
      )}, which is unusually high for this kind of transaction.`,
    });
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface BuildPreviewInput {
  /** The decoded envelope, or null when it could not be parsed. */
  parsed: ParsedTransaction | null;
  simulation: SimulationOutcome;
  intent: PreviewIntent;
  xlmPriceUsd?: number | null;
}

/**
 * Builds the preview the user sees before the wallet prompt.
 *
 * @returns A preview whose `ok` is false when signing must be blocked.
 */
export function buildTransactionPreview(input: BuildPreviewInput): TransactionPreview {
  const { parsed, simulation, intent } = input;
  const xlmPriceUsd = input.xlmPriceUsd ?? null;
  const feeStroops = parsed?.feeStroops ?? 0;
  const fee = {
    stroops: feeStroops,
    label: formatFee(feeStroops),
    usd: feeToUsd(feeStroops, xlmPriceUsd),
  };

  // ── Blocking cases: nothing trustworthy to show ──
  if (!parsed) {
    return {
      kind: "unknown",
      summary: "This transaction could not be read.",
      effects: [],
      warnings: [
        {
          code: "unparseable_transaction",
          severity: "danger",
          text: "The transaction envelope could not be decoded, so its effects are unknown.",
        },
      ],
      fee,
      ok: false,
      failureReason:
        "The transaction could not be decoded, so it was not sent to your wallet for signing.",
      requiresAcknowledgement: true,
    };
  }

  const kind = classifyTransaction(parsed);

  if (!simulation.ok) {
    return {
      kind,
      summary: describeSummary(kind, parsed, intent),
      // The effects are what it *would* have done; shown so the user can see
      // which transaction failed, never as a claim that it will happen.
      effects: describeEffects(kind, parsed, intent),
      warnings: [
        {
          code: "simulation_failed",
          severity: "danger",
          text: `The network rejected this transaction in simulation: ${simulation.error}`,
        },
      ],
      fee,
      ok: false,
      failureReason: `Simulation failed, so your wallet was not asked to sign: ${simulation.error}`,
      requiresAcknowledgement: true,
    };
  }

  const warnings = collectWarnings(kind, parsed, intent);

  const effects = describeEffects(kind, parsed, intent);
  effects.push({
    kind: "fee",
    text: `Network fee of up to ${fee.label}${fee.usd ? ` (about $${fee.usd})` : ""}`,
  });

  return {
    kind,
    summary: describeSummary(kind, parsed, intent),
    effects,
    warnings,
    fee,
    ok: true,
    requiresAcknowledgement: warnings.some((warning) => warning.severity === "danger"),
  };
}
