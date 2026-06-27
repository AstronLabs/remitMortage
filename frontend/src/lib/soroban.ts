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

const DEFAULT_NETWORK = Networks.TESTNET;
const DEFAULT_GOAL = "savings";

function escrowContractId(): string {
  return process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ID || "";
}

function networkPassphrase(): string {
  return process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || DEFAULT_NETWORK;
}

function getSimulationError<T extends object>(simulation: T): string | null {
  if (!("error" in simulation)) {
    return null;
  }

  const error = (simulation as { error?: unknown }).error;
  return typeof error === "string" ? error : null;
}

export async function buildDepositTx(borrower: string, amount: string): Promise<string> {
  const server = getRpcServer();
  const source = await server.getAccount(borrower);
  const contract = new Contract(escrowContractId());
  const amountStroops = BigInt(Math.round(parseFloat(amount) * 10_000_000));

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
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

  return SorobanRpc.assembleTransaction(tx, simulated).build().toXDR();
}

export async function buildWithdrawTx(borrower: string): Promise<string> {
  const server = getRpcServer();
  const source = await server.getAccount(borrower);
  const contract = new Contract(escrowContractId());

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
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

  return SorobanRpc.assembleTransaction(tx, simulated).build().toXDR();
}

export async function signAndSubmit(txXdr: string): Promise<string> {
  const freighter = await import("@stellar/freighter-api");
  if (typeof freighter.signTransaction !== "function") {
    throw new Error("Freighter signing API is unavailable");
  }

  const signedXdr = await freighter.signTransaction(txXdr, {
    networkPassphrase: networkPassphrase(),
  });

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

export async function queryEscrowConfig(publicKey: string): Promise<{ earlyWithdrawalPenaltyBps: number; savingsTarget: string }> {
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
    savingsTarget: (val._attributes.savings_target?.toString() || "0"),
  };
}
