import {
  Contract,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  nativeToScVal,
  Address,
  rpc as SorobanRpc,
} from "@stellar/stellar-sdk";
import { getRpcServer } from "./soroban-rpc";
import {
  buildSimulationCacheKey,
  readCachedSimulation,
  writeCachedSimulation,
} from "./simulation-cache";
import { classifyWalletError } from "./wallet-errors";

const DEFAULT_NETWORK = Networks.TESTNET;
const DEFAULT_GOAL = "savings";

// ---------------------------------------------------------------------------
// Gas / resource configuration
// ---------------------------------------------------------------------------

/**
 * Optional overrides applied when assembling a Soroban transaction.
 *
 * All fields are optional — omitting a field keeps the simulation-derived
 * default.  When a field is provided its value is written directly into the
 * transaction envelope, bypassing the simulation estimate for that dimension.
 *
 * Units:
 *   maxFeeStoops          — total transaction fee cap in stroops (1 XLM = 10⁷)
 *   resourceFeeStroops    — Soroban resource fee portion in stroops
 *   instructions          — CPU instruction count budget
 *   readBytes / writeBytes— ledger read / write byte budgets
 *   readEntries / writeEntries — ledger entry access counts
 */
export interface GasConfig {
  maxFeeStroops?: string;
  resourceFeeStroops?: string;
  instructions?: string;
  readBytes?: string;
  writeBytes?: string;
  readEntries?: string;
  writeEntries?: string;
}

/**
 * Simulation estimates extracted from a successful simulateTransaction call.
 * Returned alongside the XDR so callers can display them in the UI before
 * the user commits to a custom override.
 */
export interface SimulationEstimate {
  /** Minimum fee required by the network in stroops. */
  minResourceFeeStroops: string;
  /** CPU instruction units consumed. */
  instructions: string;
  /** Ledger read bytes. */
  readBytes: string;
  /** Ledger write bytes. */
  writeBytes: string;
  /** Ledger read entries. */
  readEntries: string;
  /** Ledger write entries. */
  writeEntries: string;
}

/**
 * Result returned by build functions — carries the assembled XDR *and* the
 * simulation estimates so the UI can show them in the gas panel.
 */
export interface BuildResult {
  xdr: string;
  estimate: SimulationEstimate;
}

/**
 * Estimate served straight from the session cache, without an RPC roundtrip.
 * Lets a modal render fee options while the real simulation is still in flight.
 */
export function peekCachedEstimate(
  method: string,
  account: string,
  args: Array<string | number | bigint> = []
): SimulationEstimate | null {
  return readCachedSimulation(
    buildSimulationCacheKey({
      contractId: escrowContractId(),
      method,
      account,
      args,
    })
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function escrowContractId(): string {
  return process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ID || "";
}

function networkPassphrase(): string {
  return process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || DEFAULT_NETWORK;
}

function getSimulationError<T extends object>(simulation: T): string | null {
  if (!("error" in simulation)) return null;
  const error = (simulation as { error?: unknown }).error;
  return typeof error === "string" ? error : null;
}

/**
 * Extract the resource footprint from a successful simulation response.
 * Returns zeros when the response does not carry the expected shape so the
 * UI always has something to display.
 */
function extractEstimate(
  sim: SorobanRpc.Api.SimulateTransactionResponse
): SimulationEstimate {
  // The simulation type narrows to SimulateTransactionSuccessResponse only
  // when it has a `result` field.  We access the raw `minResourceFee` and
  // the transaction data footprint defensively.
  const raw = sim as unknown as Record<string, unknown>;

  const minResourceFeeStroops =
    typeof raw.minResourceFee === "string"
      ? raw.minResourceFee
      : typeof (raw as any).minResourceFee === "number"
        ? String((raw as any).minResourceFee)
        : "0";

  // transactionData is a SorobanDataBuilder / xdr.SorobanTransactionData
  const td = (raw as any).transactionData;

  let instructions = "0";
  let readBytes = "0";
  let writeBytes = "0";
  let readEntries = "0";
  let writeEntries = "0";

  if (td) {
    try {
      // If it's already an XDR object with accessor methods:
      const resources =
        typeof td.resources === "function" ? td.resources() : td._attributes?.resources;

      if (resources) {
        const getNum = (v: unknown) =>
          typeof v === "number"
            ? String(v)
            : typeof (v as any)?.toString === "function"
              ? (v as any).toString()
              : "0";

        instructions = getNum(
          typeof resources.instructions === "function"
            ? resources.instructions()
            : resources._attributes?.instructions
        );
        readBytes = getNum(
          typeof resources.readBytes === "function"
            ? resources.readBytes()
            : resources._attributes?.readBytes
        );
        writeBytes = getNum(
          typeof resources.writeBytes === "function"
            ? resources.writeBytes()
            : resources._attributes?.writeBytes
        );

        const footprint =
          typeof resources.footprint === "function"
            ? resources.footprint()
            : resources._attributes?.footprint;

        if (footprint) {
          const ro =
            typeof footprint.readOnly === "function"
              ? footprint.readOnly()
              : footprint._attributes?.readOnly;
          const rw =
            typeof footprint.readWrite === "function"
              ? footprint.readWrite()
              : footprint._attributes?.readWrite;

          readEntries = String(Array.isArray(ro) ? ro.length : 0);
          writeEntries = String(Array.isArray(rw) ? rw.length : 0);
        }
      }
    } catch {
      // Defensive — leave zeros if XDR parsing fails.
    }
  }

  return {
    minResourceFeeStroops,
    instructions,
    readBytes,
    writeBytes,
    readEntries,
    writeEntries,
  };
}

/**
 * Apply GasConfig overrides to an already-assembled transaction XDR.
 *
 * The assembled XDR has SorobanTransactionData embedded in its sorobanData
 * extension.  We re-parse the envelope, patch the fee/resource fields that
 * the caller overrode, and re-serialise.
 *
 * Only the fields the caller explicitly set are mutated; everything else
 * keeps the simulation-derived value.
 */
function applyGasOverrides(assembledXdr: string, config: GasConfig): string {
  if (Object.keys(config).length === 0) return assembledXdr;

  try {
    const { TransactionBuilder: TB, xdr } = require("@stellar/stellar-sdk");
    const tx = TB.fromXDR(assembledXdr, networkPassphrase()) as ReturnType<
      typeof TB.fromXDR
    >;

    // Override the base fee (total fee cap) when the caller specified it.
    if (config.maxFeeStroops !== undefined && config.maxFeeStroops !== "") {
      const parsed = parseInt(config.maxFeeStroops, 10);
      if (!isNaN(parsed) && parsed > 0) {
        // TransactionBuilder exposes fee as a string on the built transaction.
        (tx as any).fee = String(parsed);
      }
    }

    // Patch the SorobanTransactionData resource fields.
    const sorobanData: any = (tx as any).toEnvelope?.()
      ?.v1?.()
      ?.tx?.()
      ?.ext?.()
      ?.sorobanData?.();

    if (sorobanData) {
      const resources: any = sorobanData.resources?.();

      if (resources) {
        if (config.instructions !== undefined && config.instructions !== "") {
          const v = parseInt(config.instructions, 10);
          if (!isNaN(v) && v >= 0)
            resources._attributes.instructions = v;
        }
        if (config.readBytes !== undefined && config.readBytes !== "") {
          const v = parseInt(config.readBytes, 10);
          if (!isNaN(v) && v >= 0)
            resources._attributes.readBytes = v;
        }
        if (config.writeBytes !== undefined && config.writeBytes !== "") {
          const v = parseInt(config.writeBytes, 10);
          if (!isNaN(v) && v >= 0)
            resources._attributes.writeBytes = v;
        }
      }

      if (
        config.resourceFeeStroops !== undefined &&
        config.resourceFeeStroops !== ""
      ) {
        const v = parseInt(config.resourceFeeStroops, 10);
        if (!isNaN(v) && v >= 0) {
          sorobanData._attributes.resourceFee = xdr.Int64.fromString(
            String(v)
          );
        }
      }
    }

    return (tx as any).toEnvelope().toXDR("base64");
  } catch {
    // If patching fails for any reason, fall back to the unmodified XDR
    // so the transaction can still be submitted.
    return assembledXdr;
  }
}

// ---------------------------------------------------------------------------
// Public build functions
// ---------------------------------------------------------------------------

/**
 * Build an assembled deposit transaction XDR.
 *
 * @param borrower  Stellar public key of the depositing account.
 * @param amount    Amount in USDC (decimal string, e.g. "100.50").
 * @param gas       Optional gas/resource overrides.  When omitted the
 *                  simulation-derived defaults are used.
 * @returns         Assembled XDR and the raw simulation estimates.
 */
export async function buildDepositTx(
  borrower: string,
  amount: string,
  gas: GasConfig = {}
): Promise<BuildResult> {
  const server = getRpcServer();
  const source = await server.getAccount(borrower);
  const contract = new Contract(escrowContractId());
  const amountStroops = BigInt(Math.round(parseFloat(amount) * 10_000_000));

  const tx = new TransactionBuilder(source, {
    fee: gas.maxFeeStroops || BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(
      contract.call(
        "deposit",
        Address.fromString(borrower).toScVal(),
        nativeToScVal(DEFAULT_GOAL, { type: "symbol" }),
        nativeToScVal(amountStroops, { type: "i128" })
      )
    )
    .setTimeout(300)
    .build();

  const simulated = await server.simulateTransaction(tx);
  const simulationError = getSimulationError(simulated);
  if (simulationError) {
    throw new Error(`Simulation failed: ${simulationError}`);
  }

  const estimate = extractEstimate(simulated);
  writeCachedSimulation(
    buildSimulationCacheKey({
      contractId: escrowContractId(),
      method: "deposit",
      account: borrower,
      args: [amountStroops.toString()],
    }),
    estimate
  );

  let xdr = SorobanRpc.assembleTransaction(tx, simulated).build().toXDR();
  xdr = applyGasOverrides(xdr, gas);

  return { xdr, estimate };
}

/**
 * Build an assembled withdraw transaction XDR.
 *
 * @param borrower  Stellar public key of the withdrawing account.
 * @param gas       Optional gas/resource overrides.
 * @returns         Assembled XDR and the raw simulation estimates.
 */
export async function buildWithdrawTx(
  borrower: string,
  gas: GasConfig = {}
): Promise<BuildResult> {
  const server = getRpcServer();
  const source = await server.getAccount(borrower);
  const contract = new Contract(escrowContractId());

  const tx = new TransactionBuilder(source, {
    fee: gas.maxFeeStroops || BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(
      contract.call(
        "withdraw",
        Address.fromString(borrower).toScVal(),
        nativeToScVal(DEFAULT_GOAL, { type: "symbol" })
      )
    )
    .setTimeout(300)
    .build();

  const simulated = await server.simulateTransaction(tx);
  const simulationError = getSimulationError(simulated);
  if (simulationError) {
    throw new Error(`Simulation failed: ${simulationError}`);
  }

  const estimate = extractEstimate(simulated);
  writeCachedSimulation(
    buildSimulationCacheKey({
      contractId: escrowContractId(),
      method: "withdraw",
      account: borrower,
    }),
    estimate
  );

  let xdr = SorobanRpc.assembleTransaction(tx, simulated).build().toXDR();
  xdr = applyGasOverrides(xdr, gas);

  return { xdr, estimate };
}

/**
 * Error thrown when the wallet itself fails the request — a declined signature,
 * a network mismatch, a locked or missing extension. Carries the classified
 * `WalletError` so modals can offer the right recovery action.
 */
export class WalletSignatureError extends Error {
  readonly wallet: ReturnType<typeof classifyWalletError>;

  constructor(cause: unknown) {
    const wallet = classifyWalletError(cause);
    super(wallet.message);
    this.name = "WalletSignatureError";
    this.wallet = wallet;
    this.cause = cause;
  }
}

/**
 * Sign with Freighter and submit. Wallet-side failures (rejection, wrong
 * network, locked extension) are rethrown as `WalletSignatureError`; network
 * and submission failures keep their plain messages.
 */
export async function signAndSubmit(txXdr: string): Promise<string> {
  let signedXdr: string;

  try {
    const freighter = await import("@stellar/freighter-api");
    if (typeof freighter.signTransaction !== "function") {
      throw new Error("Freighter signing API is unavailable");
    }

    const signed: unknown = await freighter.signTransaction(txXdr, {
      networkPassphrase: networkPassphrase(),
    });

    // Newer Freighter builds resolve with an error payload instead of throwing.
    if (signed && typeof signed === "object" && "error" in signed) {
      throw signed;
    }
    if (typeof signed !== "string" || signed.length === 0) {
      throw new Error("Freighter returned no signed transaction");
    }

    signedXdr = signed;
  } catch (error) {
    throw new WalletSignatureError(error);
  }

  const server = getRpcServer();
  const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase());
  const sendResponse = await server.sendTransaction(tx);

  if (sendResponse.status === "ERROR") {
    throw new Error("Submission failed on Stellar.");
  }
  if (sendResponse.status === "TRY_AGAIN_LATER") {
    throw new Error("Submission delayed by the network. Please retry.");
  }

  return sendResponse.hash;
}

export async function queryEscrowConfig(
  publicKey: string
): Promise<{ earlyWithdrawalPenaltyBps: number; savingsTarget: string }> {
  const server = getRpcServer();
  const source = await server.getAccount(publicKey);
  const contract = new Contract(escrowContractId());

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(contract.call("get_escrow_config"))
    .setTimeout(300)
    .build();

  const simulated = await server.simulateTransaction(tx);
  if (getSimulationError(simulated)) {
    return { earlyWithdrawalPenaltyBps: 500, savingsTarget: "0" };
  }
  if (!("result" in simulated) || !simulated.result) {
    return { earlyWithdrawalPenaltyBps: 500, savingsTarget: "0" };
  }

  const result = simulated.result as any;
  const val = result.retval;
  return {
    earlyWithdrawalPenaltyBps: Number(val._attributes.early_withdrawal_penalty_bps) || 500,
    savingsTarget: val._attributes.savings_target?.toString() || "0",
  };
}
