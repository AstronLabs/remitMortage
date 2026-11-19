// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Transaction simulation preview before wallet signing (issue #884).
 *
 * The acceptance criteria are both checked against **real envelopes**: every
 * transaction here is built with the Stellar SDK exactly as the app builds it,
 * serialised to XDR, and then decoded back through
 * `parseTransactionEnvelope` — the same path a wallet prompt would take. So
 * "the preview matches what the transaction does" is not asserted against a
 * hand-written fixture; it is asserted against the bytes.
 *
 * `soroban-client.test.ts` covers the other criterion end-to-end: a failed
 * simulation never reaches Freighter.
 */

import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";

import { parseTransactionEnvelope } from "../soroban-client";
import {
  HIGH_FEE_STROOPS,
  SimulationBlockedError,
  TRANSACTION_KIND_LABELS,
  bpsToPercent,
  buildTransactionPreview,
  classifyTransaction,
  normalizeAmount,
  shortenAddress,
  stroopsToDecimal,
  type ParsedTransaction,
  type PreviewIntent,
  type TransactionPreview,
} from "../transaction-preview";

const NETWORK = Networks.TESTNET;
const ESCROW = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";
const POOL = "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K";

const BORROWER = Keypair.random().publicKey();

beforeAll(() => {
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE = NETWORK;
  process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ID = ESCROW;
});

/** Builds, serialises and re-decodes an envelope, as the preview path does. */
function envelopeFor(
  build: (builder: TransactionBuilder) => TransactionBuilder,
  options: { source?: string; fee?: string } = {}
): ParsedTransaction {
  const source = new Account(options.source ?? BORROWER, "42");
  const builder = new TransactionBuilder(source, {
    fee: options.fee ?? BASE_FEE,
    networkPassphrase: NETWORK,
  });
  const xdr = build(builder).setTimeout(300).build().toXDR();

  const parsed = parseTransactionEnvelope(xdr);
  if (!parsed) throw new Error("test envelope failed to decode");
  return parsed;
}

function usdcStroops(amount: string): bigint {
  return BigInt(Math.round(parseFloat(amount) * 10_000_000));
}

function depositEnvelope(amount = "100.5", account = BORROWER, contractId = ESCROW) {
  return envelopeFor(
    (builder) =>
      builder.addOperation(
        new Contract(contractId).call(
          "deposit",
          Address.fromString(account).toScVal(),
          nativeToScVal("savings", { type: "symbol" }),
          nativeToScVal(usdcStroops(amount), { type: "i128" })
        )
      ),
    { source: account }
  );
}

function preview(
  parsed: ParsedTransaction | null,
  intent: PreviewIntent = { account: BORROWER },
  simulation: Parameters<typeof buildTransactionPreview>[0]["simulation"] = { ok: true }
): TransactionPreview {
  return buildTransactionPreview({ parsed, simulation, intent, xlmPriceUsd: 0.12 });
}

function warningCodes(result: TransactionPreview): string[] {
  return result.warnings.map((warning) => warning.code);
}

function effectText(result: TransactionPreview): string {
  return result.effects.map((effect) => effect.text).join(" | ");
}

// ── Formatting helpers ───────────────────────────────────────────────────

describe("formatting helpers", () => {
  it.each([
    ["1005000000", "100.5"],
    ["10000000", "1"],
    ["1", "0.0000001"],
    ["0", "0"],
    ["123456789", "12.3456789"],
  ])("stroopsToDecimal(%s) is %s", (stroops, expected) => {
    expect(stroopsToDecimal(stroops)).toBe(expected);
  });

  it("treats 100.50 and 100.5 as the same amount", () => {
    expect(normalizeAmount("100.50")).toBe(normalizeAmount("100.5"));
    expect(normalizeAmount("0100.500")).toBe("100.5");
  });

  it("renders basis points as a percentage", () => {
    expect(bpsToPercent(500)).toBe("5");
    expect(bpsToPercent(1250)).toBe("12.5");
    expect(bpsToPercent(0)).toBe("0");
  });

  it("shortens an address to something a human can compare", () => {
    expect(shortenAddress(BORROWER)).toBe(`${BORROWER.slice(0, 6)}…${BORROWER.slice(-4)}`);
    expect(shortenAddress("short")).toBe("short");
  });
});

// ── Envelope decoding ────────────────────────────────────────────────────

describe("parseTransactionEnvelope", () => {
  it("decodes a Soroban contract call down to its arguments", () => {
    const parsed = depositEnvelope("250.75");

    expect(parsed.source).toBe(BORROWER);
    expect(parsed.feeStroops).toBe(Number(BASE_FEE));
    expect(parsed.operations).toHaveLength(1);
    expect(parsed.operations[0]).toMatchObject({
      type: "invokeHostFunction",
      contractId: ESCROW,
      functionName: "deposit",
    });
    expect(parsed.operations[0].args).toEqual([BORROWER, "savings", "2507500000"]);
  });

  it("decodes a classic payment", () => {
    const destination = Keypair.random().publicKey();
    const issuer = Keypair.random().publicKey();
    const parsed = envelopeFor((builder) =>
      builder.addOperation(
        Operation.payment({
          destination,
          asset: new Asset("USDC", issuer),
          amount: "42.5",
        })
      )
    );

    expect(parsed.operations[0]).toMatchObject({
      type: "payment",
      destination,
      assetCode: "USDC",
    });
    expect(normalizeAmount(parsed.operations[0].amount as string)).toBe("42.5");
  });

  it("decodes setOptions signers and thresholds", () => {
    const signer = Keypair.random().publicKey();
    const parsed = envelopeFor((builder) =>
      builder.addOperation(
        Operation.setOptions({
          signer: { ed25519PublicKey: signer, weight: 2 },
          lowThreshold: 2,
          medThreshold: 3,
          highThreshold: 3,
          masterWeight: 1,
        })
      )
    );

    expect(parsed.operations[0].signers).toEqual([{ key: signer, weight: 2 }]);
    expect(parsed.operations[0].thresholds).toMatchObject({
      masterWeight: 1,
      low: 2,
      medium: 3,
      high: 3,
    });
  });

  it("returns null for an envelope it cannot read", () => {
    expect(parseTransactionEnvelope("not-base64-xdr")).toBeNull();
    expect(parseTransactionEnvelope("")).toBeNull();
  });
});

// ── Classification ───────────────────────────────────────────────────────

describe("classifyTransaction", () => {
  it.each([
    ["deposit", "escrow_deposit"],
    ["withdraw", "escrow_withdraw"],
    ["repay", "loan_repayment"],
    ["approve_milestone", "milestone_approval"],
    ["transfer", "token_transfer"],
    ["drain_everything", "unknown"],
  ])("maps the %s contract call to %s", (functionName, kind) => {
    const parsed = envelopeFor((builder) =>
      builder.addOperation(
        new Contract(ESCROW).call(functionName, Address.fromString(BORROWER).toScVal())
      )
    );

    expect(classifyTransaction(parsed)).toBe(kind);
  });

  it("recognises a signing-policy change", () => {
    const parsed = envelopeFor((builder) =>
      builder.addOperation(Operation.setOptions({ highThreshold: 3 }))
    );
    expect(classifyTransaction(parsed)).toBe("multisig_setup");
  });

  it("falls back to unknown for an empty envelope", () => {
    expect(classifyTransaction({ source: BORROWER, feeStroops: 100, operations: [] })).toBe(
      "unknown"
    );
  });

  it("labels every kind it can produce", () => {
    for (const label of Object.values(TRANSACTION_KIND_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

// ── The preview matches the real effects, per transaction type ───────────

describe("escrow deposit", () => {
  const intent: PreviewIntent = {
    account: BORROWER,
    amount: "100.5",
    asset: "USDC",
    expectedRecipients: [ESCROW],
  };

  it("summarises the amount and destination taken from the envelope", () => {
    const result = preview(depositEnvelope("100.5"), intent);

    expect(result.kind).toBe("escrow_deposit");
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(
      "Move 100.5 USDC from your wallet into your savings escrow."
    );
    expect(result.warnings).toEqual([]);
    expect(result.requiresAcknowledgement).toBe(false);
  });

  it("lists the debit, the credit and the fee", () => {
    const result = preview(depositEnvelope("100.5"), intent);

    expect(result.effects.map((effect) => effect.kind)).toEqual(["debit", "credit", "fee"]);
    expect(result.effects[0].text).toBe("100.5 USDC leaves your wallet");
    expect(result.effects[0].amount).toBe("100.5");
    expect(result.effects[1].counterparty).toBe(ESCROW);
    expect(result.effects[2].text).toContain("Network fee of up to");
  });

  it("reads the amount from the envelope, not from the form", () => {
    // The envelope moves 999; the form said 100.5. The envelope wins, and the
    // disagreement is the warning — this is the malicious-build case.
    const result = preview(depositEnvelope("999"), intent);

    expect(warningCodes(result)).toContain("amount_mismatch");
    expect(result.requiresAcknowledgement).toBe(true);
    expect(result.effects[0].text).toBe("999 USDC leaves your wallet");
    expect(
      result.warnings.find((warning) => warning.code === "amount_mismatch")?.text
    ).toBe("You entered 100.5 but this transaction moves 999.");
  });

  it("warns when the funds would go to a contract that is not ours", () => {
    const result = preview(depositEnvelope("100.5", BORROWER, POOL), intent);

    expect(warningCodes(result)).toContain("unexpected_recipient");
    expect(result.requiresAcknowledgement).toBe(true);
  });

  it("warns when the envelope is signed by a different account", () => {
    const stranger = Keypair.random().publicKey();
    const result = preview(depositEnvelope("100.5", stranger), {
      ...intent,
      expectedRecipients: [ESCROW],
    });

    expect(warningCodes(result)).toContain("unexpected_source");
  });

  it("warns when the amount exceeds the wallet balance", () => {
    const result = preview(depositEnvelope("100.5"), { ...intent, balance: "40" });

    expect(warningCodes(result)).toContain("balance_exceeded");
    // A balance warning is not a danger: the user may be about to top up.
    expect(result.warnings.find((w) => w.code === "balance_exceeded")?.severity).toBe("warning");
  });

  it("warns when the fee cap is unusually high", () => {
    const result = preview(
      envelopeFor(
        (builder) =>
          builder.addOperation(
            new Contract(ESCROW).call(
              "deposit",
              Address.fromString(BORROWER).toScVal(),
              nativeToScVal("savings", { type: "symbol" }),
              nativeToScVal(usdcStroops("100.5"), { type: "i128" })
            )
          ),
        { fee: String(HIGH_FEE_STROOPS + 1) }
      ),
      intent
    );

    expect(warningCodes(result)).toContain("high_fee");
  });

  it("warns when several operations are bundled into one deposit", () => {
    const result = preview(
      envelopeFor((builder) =>
        builder
          .addOperation(
            new Contract(ESCROW).call(
              "deposit",
              Address.fromString(BORROWER).toScVal(),
              nativeToScVal("savings", { type: "symbol" }),
              nativeToScVal(usdcStroops("100.5"), { type: "i128" })
            )
          )
          .addOperation(
            new Contract(ESCROW).call("withdraw", Address.fromString(BORROWER).toScVal())
          )
      ),
      intent
    );

    expect(warningCodes(result)).toContain("multiple_operations");
    expect(result.requiresAcknowledgement).toBe(true);
  });
});

describe("escrow withdrawal", () => {
  function withdrawEnvelope() {
    return envelopeFor((builder) =>
      builder.addOperation(
        new Contract(ESCROW).call(
          "withdraw",
          Address.fromString(BORROWER).toScVal(),
          nativeToScVal("savings", { type: "symbol" })
        )
      )
    );
  }

  it("describes the return of funds with no penalty", () => {
    const result = preview(withdrawEnvelope(), {
      account: BORROWER,
      expectedRecipients: [ESCROW],
    });

    expect(result.kind).toBe("escrow_withdraw");
    expect(result.summary).toBe("Withdraw your escrow savings back to your wallet.");
    expect(effectText(result)).toContain("returned to your wallet");
    expect(warningCodes(result)).toEqual([]);
  });

  it("spells out the early-withdrawal penalty in the summary, effects and warnings", () => {
    const result = preview(withdrawEnvelope(), {
      account: BORROWER,
      penaltyBps: 500,
      expectedRecipients: [ESCROW],
    });

    expect(result.summary).toBe(
      "Withdraw your escrow savings early, minus a 5% penalty."
    );
    expect(effectText(result)).toContain("early-withdrawal penalty of 5%");
    expect(warningCodes(result)).toEqual(["penalty_applied"]);
    // A penalty is a real choice, not a reason to block or to demand a second
    // acknowledgement — the modal already has its own penalty checkbox.
    expect(result.requiresAcknowledgement).toBe(false);
  });
});

describe("loan repayment", () => {
  it("describes the debit and the pool it is applied to", () => {
    const parsed = envelopeFor((builder) =>
      builder.addOperation(
        new Contract(POOL).call(
          "repay",
          Address.fromString(BORROWER).toScVal(),
          nativeToScVal(usdcStroops("250"), { type: "i128" })
        )
      )
    );

    const result = preview(parsed, {
      account: BORROWER,
      amount: "250",
      expectedRecipients: [POOL],
    });

    expect(result.kind).toBe("loan_repayment");
    expect(result.summary).toBe("Repay 250 USDC toward your loan.");
    expect(result.effects[0].text).toBe("250 USDC leaves your wallet");
    expect(result.effects[1].counterparty).toBe(POOL);
    expect(warningCodes(result)).toEqual([]);
  });
});

describe("milestone approval", () => {
  it("states plainly that no funds move", () => {
    const parsed = envelopeFor((builder) =>
      builder.addOperation(
        new Contract(POOL).call(
          "approve_milestone",
          nativeToScVal("milestone-7", { type: "symbol" })
        )
      )
    );

    const result = preview(parsed, {
      account: BORROWER,
      referenceId: "milestone-7",
      expectedRecipients: [POOL],
    });

    expect(result.kind).toBe("milestone_approval");
    expect(result.summary).toBe(
      "Approve a milestone disbursement. No funds leave your wallet."
    );
    expect(effectText(result)).toContain("Records your approval for milestone milestone-7");
    expect(effectText(result)).toContain("No funds leave your wallet");
    expect(warningCodes(result)).toEqual([]);
  });
});

describe("signing-policy change", () => {
  it("lists every signer and threshold change across all operations", () => {
    const signerA = Keypair.random().publicKey();
    const signerB = Keypair.random().publicKey();

    const parsed = envelopeFor((builder) =>
      builder
        .addOperation(
          Operation.setOptions({ lowThreshold: 2, medThreshold: 2, highThreshold: 2 })
        )
        .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: signerA, weight: 1 } }))
        .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: signerB, weight: 1 } }))
    );

    const result = preview(parsed, { account: BORROWER });

    expect(result.kind).toBe("multisig_setup");
    expect(result.summary).toContain("2 signer changes");
    expect(effectText(result)).toContain(`Adds ${shortenAddress(signerA)} as a signer with weight 1`);
    expect(effectText(result)).toContain(`Adds ${shortenAddress(signerB)} as a signer with weight 1`);
    expect(effectText(result)).toContain("low threshold to 2");
  });

  it("describes a signer removal as a removal", () => {
    const signer = Keypair.random().publicKey();
    const parsed = envelopeFor((builder) =>
      builder.addOperation(Operation.setOptions({ signer: { ed25519PublicKey: signer, weight: 0 } }))
    );

    expect(effectText(preview(parsed, { account: BORROWER }))).toContain(
      `Removes ${shortenAddress(signer)} as a signer`
    );
  });

  it("always requires an acknowledgement, because it can lock the account", () => {
    const parsed = envelopeFor((builder) =>
      builder.addOperation(Operation.setOptions({ highThreshold: 3 }))
    );

    const result = preview(parsed, { account: BORROWER });

    expect(warningCodes(result)).toContain("signer_policy_change");
    expect(result.requiresAcknowledgement).toBe(true);
    // Still signable — this is a legitimate operation, just a dangerous one.
    expect(result.ok).toBe(true);
  });
});

describe("classic token transfer", () => {
  it("names the recipient and the asset from the envelope", () => {
    const destination = Keypair.random().publicKey();
    const issuer = Keypair.random().publicKey();
    const parsed = envelopeFor((builder) =>
      builder.addOperation(
        Operation.payment({
          destination,
          asset: new Asset("USDC", issuer),
          amount: "75.25",
        })
      )
    );

    const result = preview(parsed, { account: BORROWER, amount: "75.25" });

    expect(result.kind).toBe("token_transfer");
    expect(result.summary).toBe(
      `Send 75.2500000 USDC to ${shortenAddress(destination)}.`
    );
    expect(result.effects[0].counterparty).toBe(destination);
    expect(warningCodes(result)).toEqual([]);
  });
});

describe("an unrecognised transaction", () => {
  it("says so rather than guessing, and demands an acknowledgement", () => {
    const parsed = envelopeFor((builder) =>
      builder.addOperation(
        new Contract(POOL).call("set_admin", Address.fromString(BORROWER).toScVal())
      )
    );

    const result = preview(parsed, { account: BORROWER });

    expect(result.kind).toBe("unknown");
    expect(result.summary).toContain("calls set_admin() on a contract RemitMortgage does not recognise");
    expect(effectText(result)).toContain("Calls set_admin() on contract");
    expect(warningCodes(result)).toContain("unknown_transaction");
    expect(result.requiresAcknowledgement).toBe(true);
  });

  it("refuses an envelope with no operations at all", () => {
    const result = preview({ source: BORROWER, feeStroops: 100, operations: [] }, {
      account: BORROWER,
    });

    expect(warningCodes(result)).toEqual(["no_operations"]);
    expect(result.requiresAcknowledgement).toBe(true);
  });
});

// ── Blocking: a failed simulation, and an unreadable envelope ────────────

describe("a failed simulation", () => {
  it("is not ok, so the caller must not open the wallet prompt", () => {
    const result = preview(depositEnvelope("100.5"), { account: BORROWER, amount: "100.5" }, {
      ok: false,
      error: "HostError: Error(Contract, #4) insufficient balance",
    });

    expect(result.ok).toBe(false);
    expect(result.failureReason).toContain("Simulation failed");
    expect(result.failureReason).toContain("insufficient balance");
    expect(warningCodes(result)).toEqual(["simulation_failed"]);
  });

  it("still names the transaction, so the user knows which one failed", () => {
    const result = preview(depositEnvelope("100.5"), { account: BORROWER }, {
      ok: false,
      error: "trustline missing",
    });

    expect(result.summary).toBe(
      "Move 100.5 USDC from your wallet into your savings escrow."
    );
    expect(result.kind).toBe("escrow_deposit");
  });

  it("blocks an envelope that could not be decoded", () => {
    const result = preview(null, { account: BORROWER });

    expect(result.ok).toBe(false);
    expect(warningCodes(result)).toEqual(["unparseable_transaction"]);
    expect(result.failureReason).toContain("not sent to your wallet");
  });
});

describe("SimulationBlockedError", () => {
  it("carries the preview and explains itself", () => {
    const blocked = preview(depositEnvelope("1"), { account: BORROWER }, {
      ok: false,
      error: "boom",
    });
    const error = new SimulationBlockedError(blocked);

    expect(error.name).toBe("SimulationBlockedError");
    expect(error.preview).toBe(blocked);
    expect(error.message).toContain("boom");
  });
});

// ── The fee is always shown ──────────────────────────────────────────────

describe("fee reporting", () => {
  it("reports the fee cap in XLM and in USD", () => {
    const result = preview(depositEnvelope("1"), { account: BORROWER });

    expect(result.fee.stroops).toBe(Number(BASE_FEE));
    expect(result.fee.label).toContain("XLM");
    expect(result.fee.usd).not.toBeNull();
  });

  it("omits the USD figure when no price is available", () => {
    const result = buildTransactionPreview({
      parsed: depositEnvelope("1"),
      simulation: { ok: true },
      intent: { account: BORROWER },
      xlmPriceUsd: null,
    });

    expect(result.fee.usd).toBeNull();
  });
});
