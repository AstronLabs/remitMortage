// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * The signing gate (issue #884): **a failed simulation prevents the signing
 * prompt.**
 *
 * The assertion that carries the acceptance criterion is always the same one —
 * `freighter.signTransaction` was never called. Checking the thrown error is
 * not enough: the wallet prompt is a side effect, and the only honest way to
 * prove it did not open is to prove the wallet API was never invoked.
 */

import { Account, Address, BASE_FEE, Contract, Keypair, Networks, TransactionBuilder, nativeToScVal } from "@stellar/stellar-sdk";

const ESCROW = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";
const NETWORK = Networks.TESTNET;
const BORROWER = Keypair.random().publicKey();

const signTransaction = jest.fn();
jest.mock("@stellar/freighter-api", () => ({
  signTransaction: (...args: unknown[]) => signTransaction(...args),
}));

const simulateTransaction = jest.fn();
const sendTransaction = jest.fn();
const getAccount = jest.fn();

jest.mock("../soroban-rpc", () => ({
  getRpcServer: () => ({
    simulateTransaction: (...args: unknown[]) => simulateTransaction(...args),
    sendTransaction: (...args: unknown[]) => sendTransaction(...args),
    getAccount: (...args: unknown[]) => getAccount(...args),
  }),
  getRpcUrl: () => "https://soroban-testnet.stellar.org",
  POLL_INTERVAL_MS: 2000,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  previewTransaction,
  signAndSubmit,
} = require("../soroban-client") as typeof import("../soroban-client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SimulationBlockedError } = require("../transaction-preview") as typeof import("../transaction-preview");

/** A real deposit envelope, the kind DepositModal would hand to signAndSubmit. */
function depositXdr(amount = "100.5"): string {
  const source = new Account(BORROWER, "7");
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(
      new Contract(ESCROW).call(
        "deposit",
        Address.fromString(BORROWER).toScVal(),
        nativeToScVal("savings", { type: "symbol" }),
        nativeToScVal(BigInt(Math.round(parseFloat(amount) * 10_000_000)), { type: "i128" })
      )
    )
    .setTimeout(300)
    .build()
    .toXDR();
}

beforeAll(() => {
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE = NETWORK;
  process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ID = ESCROW;
});

beforeEach(() => {
  jest.clearAllMocks();
  getAccount.mockResolvedValue(new Account(BORROWER, "7"));
  sendTransaction.mockResolvedValue({ status: "PENDING", hash: "abc123" });
});

const okSimulation = { minResourceFee: "54321", result: { retval: null } };

describe("signAndSubmit", () => {
  it("does not open the wallet prompt when the simulation fails", async () => {
    simulateTransaction.mockResolvedValue({ error: "HostError: insufficient balance" });

    await expect(
      signAndSubmit(depositXdr(), { intent: { account: BORROWER, amount: "100.5" } })
    ).rejects.toThrow(SimulationBlockedError);

    // The criterion.
    expect(signTransaction).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("explains which simulation failure blocked it", async () => {
    simulateTransaction.mockResolvedValue({ error: "trustline missing for USDC" });

    await expect(signAndSubmit(depositXdr())).rejects.toThrow(/trustline missing for USDC/);
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("does not open the wallet prompt when the RPC call itself throws", async () => {
    simulateTransaction.mockRejectedValue(new Error("RPC unreachable"));

    await expect(signAndSubmit(depositXdr())).rejects.toThrow(SimulationBlockedError);
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("does not open the wallet prompt for an envelope it cannot decode", async () => {
    await expect(signAndSubmit("this-is-not-xdr")).rejects.toThrow(SimulationBlockedError);

    expect(simulateTransaction).not.toHaveBeenCalled();
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("carries the blocking preview on the error, so the UI can show it", async () => {
    simulateTransaction.mockResolvedValue({ error: "Error(Contract, #4)" });

    await expect(signAndSubmit(depositXdr())).rejects.toMatchObject({
      name: "SimulationBlockedError",
      preview: expect.objectContaining({
        ok: false,
        kind: "escrow_deposit",
        warnings: [expect.objectContaining({ code: "simulation_failed" })],
      }),
    });
  });

  it("signs and submits when the simulation succeeds", async () => {
    simulateTransaction.mockResolvedValue(okSimulation);
    const xdr = depositXdr();
    const signed = depositXdr();
    signTransaction.mockResolvedValue(signed);

    const hash = await signAndSubmit(xdr, {
      intent: { account: BORROWER, amount: "100.5", expectedRecipients: [ESCROW] },
    });

    expect(hash).toBe("abc123");
    expect(signTransaction).toHaveBeenCalledWith(xdr, { networkPassphrase: NETWORK });
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("simulates exactly once when it has to build the preview itself", async () => {
    simulateTransaction.mockResolvedValue(okSimulation);
    signTransaction.mockResolvedValue(depositXdr());

    await signAndSubmit(depositXdr());

    expect(simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("reuses a preview the caller already showed, rather than simulating again", async () => {
    simulateTransaction.mockResolvedValue(okSimulation);
    const xdr = depositXdr();

    const preview = await previewTransaction(xdr, {
      intent: { account: BORROWER, amount: "100.5", expectedRecipients: [ESCROW] },
    });
    expect(preview.ok).toBe(true);
    expect(simulateTransaction).toHaveBeenCalledTimes(1);

    signTransaction.mockResolvedValue(depositXdr());
    await signAndSubmit(xdr, { preview });

    // Still one: the approved preview was reused, so the user is not made to
    // wait for a second round-trip after confirming.
    expect(simulateTransaction).toHaveBeenCalledTimes(1);
    expect(signTransaction).toHaveBeenCalledTimes(1);
  });

  it("refuses a preview the caller passes that is not ok, without simulating", async () => {
    const blocked = {
      kind: "escrow_deposit" as const,
      summary: "…",
      effects: [],
      warnings: [],
      fee: { stroops: 100, label: "0.00001 XLM", usd: null },
      ok: false,
      failureReason: "Simulation failed earlier",
      requiresAcknowledgement: true,
    };

    await expect(signAndSubmit(depositXdr(), { preview: blocked })).rejects.toThrow(
      SimulationBlockedError
    );

    expect(simulateTransaction).not.toHaveBeenCalled();
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("still classifies a wallet rejection as a wallet error, not a blocked simulation", async () => {
    simulateTransaction.mockResolvedValue(okSimulation);
    signTransaction.mockRejectedValue(new Error("User declined access"));

    await expect(signAndSubmit(depositXdr())).rejects.toMatchObject({
      name: "WalletSignatureError",
    });
  });

  it("warns rather than blocks when the envelope disagrees with the form", async () => {
    simulateTransaction.mockResolvedValue(okSimulation);

    // The envelope moves 999; the form said 100.5. The transaction simulates
    // fine, so it is signable — but only after an acknowledgement.
    const preview = await previewTransaction(depositXdr("999"), {
      intent: { account: BORROWER, amount: "100.5", expectedRecipients: [ESCROW] },
    });

    expect(preview.ok).toBe(true);
    expect(preview.requiresAcknowledgement).toBe(true);
    expect(preview.warnings.map((warning) => warning.code)).toContain("amount_mismatch");
  });
});

describe("previewTransaction", () => {
  it("does not call Soroban simulation for a classic transaction", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Operation } = require("@stellar/stellar-sdk");
    const xdr = new TransactionBuilder(new Account(BORROWER, "7"), {
      fee: BASE_FEE,
      networkPassphrase: NETWORK,
    })
      .addOperation(Operation.setOptions({ highThreshold: 2 }))
      .setTimeout(300)
      .build()
      .toXDR();

    const preview = await previewTransaction(xdr, { intent: { account: BORROWER } });

    // There is no host function to simulate; the decoded envelope is the whole
    // truth, so simulating would only produce a spurious failure.
    expect(simulateTransaction).not.toHaveBeenCalled();
    expect(preview.ok).toBe(true);
    expect(preview.kind).toBe("multisig_setup");
  });
});
