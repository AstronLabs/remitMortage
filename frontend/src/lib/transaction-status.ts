import { rpc, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";

export const STELLARCHAIN_TX_BASE = "https://testnet.stellarchain.io/transactions/";
export const STELLAR_EXPERT_TX_BASE = "https://stellar.expert/explorer/testnet/tx/";
export const TX_SUCCESS_SESSION_KEY = "rm_tx_success";

export type TransactionType =
  | "Deposit"
  | "Disbursement"
  | "Repayment"
  | "Milestone Proposal"
  | "Withdrawal"
  | "Transaction";

export type TxUiPhase =
  | "submitted"
  | "simulating"
  | "pending_confirmation"
  | "confirmed"
  | "failed";

export type TransactionModalPhase =
  | "idle"
  | "simulating"
  | "signing"
  | "pending"
  | "success"
  | "error";

export const TX_PROGRESS_STEPS = [
  "Submitted",
  "Simulating",
  "Pending Confirmation",
  "Complete",
] as const;

export const TRANSACTION_MODAL_STEPS = [
  "Simulating",
  "Awaiting Signature",
  "Confirming on Stellar",
] as const;

export function shortenAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function parseTransactionType(value: string | null): TransactionType {
  const allowed: TransactionType[] = [
    "Deposit",
    "Disbursement",
    "Repayment",
    "Milestone Proposal",
    "Withdrawal",
    "Transaction",
  ];
  if (value && allowed.includes(value as TransactionType)) {
    return value as TransactionType;
  }
  return "Transaction";
}

export function mapToUiPhase(
  rpcStatus: rpc.Api.GetTransactionStatus | null,
  pollCount: number
): TxUiPhase {
  if (rpcStatus === rpc.Api.GetTransactionStatus.SUCCESS) return "confirmed";
  if (rpcStatus === rpc.Api.GetTransactionStatus.FAILED) return "failed";
  if (pollCount <= 1) return "submitted";
  if (pollCount <= 3) return "simulating";
  return "pending_confirmation";
}

export function phaseToStepIndex(phase: TxUiPhase): number {
  switch (phase) {
    case "submitted":
      return 1;
    case "simulating":
      return 2;
    case "pending_confirmation":
      return 3;
    case "confirmed":
    case "failed":
      return 4;
    default:
      return 1;
  }
}

export function isTerminalPhase(phase: TxUiPhase): boolean {
  return phase === "confirmed" || phase === "failed";
}

export function getTransactionExplorerLinks(hash: string) {
  return [
    {
      label: "View on Stellarchain",
      href: `${STELLARCHAIN_TX_BASE}${hash}`,
    },
    {
      label: "View on Stellar Expert",
      href: `${STELLAR_EXPERT_TX_BASE}${hash}`,
    },
  ];
}

export function formatTransactionErrorMessage(error: unknown): string {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : typeof error === "object" &&
            error !== null &&
            "message" in error &&
            typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : "Transaction could not be completed.";

  const cleaned = message
    .replace(/^Simulation failed:\s*/i, "")
    .replace(/^Submission failed:\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (/trInvokeHostFunction/i.test(cleaned)) {
    return "The contract rejected the transaction. Review the on-chain diagnostics for details.";
  }

  return cleaned || "Transaction could not be completed.";
}

function readSwitchName(value: { switch: () => unknown }): string {
  const sw = value.switch();
  if (typeof sw === "object" && sw !== null && "name" in sw) {
    return String((sw as { name: string }).name);
  }
  return String(sw);
}

export function extractSenderAddress(
  response: rpc.Api.GetTransactionResponse | null
): string | null {
  if (!response || response.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    return null;
  }

  try {
    const envelope = response.envelopeXdr;
    const type = readSwitchName(envelope);

    if (type === "envelopeTypeTxV0") {
      return StrKey.encodeEd25519PublicKey(envelope.v0().tx().sourceAccountEd25519());
    }
    if (type === "envelopeTypeTx") {
      return StrKey.encodeEd25519PublicKey(envelope.v1().tx().sourceAccount().ed25519());
    }
    if (type === "envelopeTypeTxFeeBump") {
      const inner = envelope.feeBump().tx().innerTx().v1().tx();
      return StrKey.encodeEd25519PublicKey(inner.sourceAccount().ed25519());
    }
  } catch {
    return null;
  }
  return null;
}

export function extractGasFee(
  response: rpc.Api.GetTransactionResponse | null
): string | null {
  if (!response || response.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    return null;
  }

  try {
    const stroops = response.resultXdr.feeCharged().toString();
    const xlm = Number(stroops) / 10_000_000;
    return `${xlm.toFixed(7)} XLM (${stroops} stroops)`;
  } catch {
    return null;
  }
}

function stringifyScVal(val: xdr.ScVal): unknown {
  try {
    return scValToNative(val);
  } catch {
    return val.toXDR("base64");
  }
}

export function extractContractError(
  response: rpc.Api.GetFailedTransactionResponse
): string {
  const messages: string[] = [];

  if (response.diagnosticEventsXdr?.length) {
    for (const event of response.diagnosticEventsXdr) {
      try {
        const body = event.event().body();
        if (readSwitchName(body) !== "contractEventBodyV0") continue;
        const data = stringifyScVal(body.v0().data());
        if (typeof data === "string" && data.trim()) {
          messages.push(data);
        } else if (data && typeof data === "object") {
          messages.push(JSON.stringify(data));
        }
      } catch {
        // Skip unparseable diagnostic events.
      }
    }
  }

  try {
    const result = response.resultXdr.result();
    if (readSwitchName(result) === "txFailed") {
      const opResults = result.results();
      for (let i = 0; i < opResults.length; i++) {
        const tr = opResults[i].tr();
        const trName = readSwitchName(tr);
        if (trName === "invokeHostFunction") {
          const code = readSwitchName(tr.invokeHostFunctionResult());
          messages.push(`Contract invocation failed: ${code}`);
        } else {
          messages.push(`Operation ${i + 1} failed: ${trName}`);
        }
      }
    }
  } catch {
    // Ignore result parsing errors.
  }

  const unique = [...new Set(messages.filter(Boolean))];
  if (unique.length > 0) {
    return unique.join(" · ");
  }

  return "Transaction reverted on-chain. Review the diagnostic logs below for details.";
}

export function formatTransactionLogs(
  response: rpc.Api.GetTransactionResponse | null,
  pollCount: number,
  phase: TxUiPhase
): Record<string, unknown> {
  if (!response) {
    return { phase, pollCount, status: "awaiting_first_poll" };
  }

  const base: Record<string, unknown> = {
    phase,
    pollCount,
    status: response.status,
    txHash: response.txHash,
    latestLedger: response.latestLedger,
    latestLedgerCloseTime: response.latestLedgerCloseTime,
  };

  if (response.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    return base;
  }

  const detailed = response as rpc.Api.GetSuccessfulTransactionResponse | rpc.Api.GetFailedTransactionResponse;

  return {
    ...base,
    ledger: detailed.ledger,
    createdAt: detailed.createdAt,
    applicationOrder: detailed.applicationOrder,
    feeBump: detailed.feeBump,
    events: detailed.events,
    diagnosticEvents: detailed.diagnosticEventsXdr?.map((event) => {
      try {
        const body = event.event().body();
        if (readSwitchName(body) === "contractEventBodyV0") {
          return {
            topics: body.v0().topics().map((topic) => stringifyScVal(topic)),
            data: stringifyScVal(body.v0().data()),
          };
        }
      } catch {
        return event.toXDR("base64");
      }
      return null;
    }),
    returnValue:
      response.status === rpc.Api.GetTransactionStatus.SUCCESS && response.returnValue
        ? stringifyScVal(response.returnValue)
        : undefined,
    contractError:
      response.status === rpc.Api.GetTransactionStatus.FAILED
        ? extractContractError(response)
        : undefined,
  };
}

export function storeTxSuccessFeedback(hash: string, type: TransactionType): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(
    TX_SUCCESS_SESSION_KEY,
    JSON.stringify({ hash, type, at: Date.now() })
  );
}

export function consumeTxSuccessFeedback(): { hash: string; type: TransactionType } | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(TX_SUCCESS_SESSION_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(TX_SUCCESS_SESSION_KEY);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
