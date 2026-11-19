# Transaction Simulation Preview

Issue #884.

Freighter shows an XDR. Nobody reads an XDR. So a user approving a transaction
is, in practice, trusting that the app built what the form said — which is
exactly the assumption a malicious or buggy build breaks. A mistaken amount, a
recipient that is not a RemitMortgage contract, a bundled second operation: all
look identical in the wallet.

This feature removes that assumption. Before the wallet is asked for anything,
the transaction is simulated, decoded, and described in a sentence.

## The guarantee

- **The signing prompt cannot open without a successful simulation.**
  `signAndSubmit` builds the preview itself when the caller does not pass one,
  and throws `SimulationBlockedError` *before* importing the wallet API when
  the preview is not `ok`. There is no code path to Freighter that skips this.
- **The description comes from the envelope, not from the form.** The amount,
  recipient, contract and function are decoded from the bytes that will be
  signed. When they disagree with what the user typed, the disagreement is the
  warning.

## Two outcomes, deliberately not conflated

| | Meaning | Effect |
| --- | --- | --- |
| `ok: false` | the simulation failed, or the envelope could not be decoded | the prompt does not open at all — there is nothing trustworthy to show, and submitting would burn a fee on a transaction that cannot succeed |
| `requiresAcknowledgement: true` | the preview is trustworthy and says something alarming | the user may proceed — an early-withdrawal penalty is a real choice — but only after ticking an explicit acknowledgement |

Collapsing these into one flag would mean either blocking legitimate
transactions (a penalty is not an error) or waving through unsignable ones.

## What the user sees

```
┌─ Before you sign ──────────────────────────────────────────┐
│ Move 100.5 USDC from your wallet into your savings escrow. │
├────────────────────────────────────────────────────────────┤
│ ↗  100.5 USDC leaves your wallet                           │
│ ↙  Credited to your savings escrow (CA3D5K…GAXE)           │
│ ⛽ Network fee of up to 0.00001 XLM (about $0.0000)        │
└────────────────────────────────────────────────────────────┘
```

And when the envelope does not match the form:

```
⚠ You entered 100.5 but this transaction moves 999.
☐ I have read the warning above and want to sign this transaction anyway.
```

## Supported transaction types

Each kind is recognised from the envelope — the contract function name for
Soroban, the operation type for classic Stellar — never from what the caller
claims it built.

| Kind | Recognised from | Summary |
| --- | --- | --- |
| `escrow_deposit` | `deposit()` | "Move 100.5 USDC from your wallet into your savings escrow." |
| `escrow_withdraw` | `withdraw()` | "Withdraw your escrow savings early, minus a 5% penalty." |
| `loan_repayment` | `repay()` | "Repay 250 USDC toward your loan." |
| `milestone_approval` | `approve_milestone()` | "Approve a milestone disbursement. No funds leave your wallet." |
| `multisig_setup` | `setOptions` | "Change who can sign for GABC…WXYZ (2 signer changes)." |
| `token_transfer` | `payment` | "Send 75.25 USDC to GDEF…1234." |
| `unknown` | anything else | "This transaction calls set_admin() on a contract RemitMortgage does not recognise." |

An `unknown` transaction is never guessed at. It is described structurally
(function name, contract, argument count) and always requires an
acknowledgement.

## Warnings

| Code | Severity | Fires when |
| --- | --- | --- |
| `simulation_failed` | danger | the network rejected the transaction in simulation (also sets `ok: false`) |
| `unparseable_transaction` | danger | the envelope could not be decoded (also sets `ok: false`) |
| `unknown_transaction` | danger | the app did not build this transaction shape |
| `amount_mismatch` | danger | the envelope moves a different amount than the form said |
| `unexpected_recipient` | danger | funds would reach an address that is not a RemitMortgage contract |
| `unexpected_source` | danger | the envelope is signed by an account other than the connected wallet |
| `multiple_operations` | danger | several operations are bundled into what should be one |
| `no_operations` | danger | the transaction would only pay a fee |
| `signer_policy_change` | danger | a `setOptions` transaction — getting thresholds wrong locks the account out permanently |
| `penalty_applied` | warning | an early withdrawal costs a percentage of the balance |
| `balance_exceeded` | warning | the amount is above the wallet balance |
| `high_fee` | warning | the fee cap is over `HIGH_FEE_STROOPS` (0.5 XLM) |

## Classic transactions are not simulated

`simulateTransaction` runs host functions. A classic `payment` or `setOptions`
has none, so simulating one would always "fail" and would block a perfectly
good transaction. `previewTransaction` therefore simulates only when the
envelope contains an `invokeHostFunction` operation.

This costs nothing in accuracy: the effects are decoded from the envelope
either way. What a classic transaction does not get is the network's advance
verdict on whether it will succeed — so for `multisig_setup`, the preview leans
on the structural description and the mandatory acknowledgement instead.

## Where it is wired in

| Surface | File |
| --- | --- |
| Escrow deposit | `frontend/src/components/DepositModal.tsx` |
| Escrow withdrawal | `frontend/src/components/WithdrawModal.tsx` |
| Multisig setup | `frontend/src/app/multisig/page.tsx` |
| The panel | `frontend/src/components/tx/TransactionPreviewPanel.tsx` |
| The gate | `signAndSubmit` / `previewTransaction` in `frontend/src/lib/soroban-client.ts` |
| The logic | `frontend/src/lib/transaction-preview.ts` (pure, no RPC) |

Each caller passes a `PreviewIntent` — the amount, asset, penalty and expected
recipients from its form — which is used **only** to cross-check the envelope,
never to describe it.

A rebuilt transaction clears the preview and the acknowledgement: a different
envelope is a different transaction, and approval of the old one does not carry
over.

## Adding a transaction type

1. Add the kind to `TransactionKind` and `TRANSACTION_KIND_LABELS`.
2. Map its contract function in `FUNCTION_KINDS` (or its operation type in
   `classifyTransaction`).
3. Add a `case` to `describeSummary` and `describeEffects`.
4. Add a test in `frontend/src/lib/__tests__/transaction-preview.test.ts` that
   builds a **real envelope** with the SDK, serialises it, decodes it through
   `parseTransactionEnvelope`, and asserts the summary and effects. Do not
   hand-write a `ParsedTransaction` fixture — the point of the test is that the
   preview matches the bytes.

Until step 2 is done, the transaction is `unknown`: described structurally and
gated behind an acknowledgement. That is the safe default, so a new type being
forgotten degrades to "warn the user" rather than "describe it wrongly".

## Tests

| What | Where |
| --- | --- |
| Preview matches the real envelope, per transaction type | `frontend/src/lib/__tests__/transaction-preview.test.ts` |
| A failed simulation never reaches Freighter | `frontend/src/lib/__tests__/soroban-client-signing.test.ts` |
| Blocked / loading / ready panel states, acknowledgement gate | `frontend/src/components/__tests__/TransactionPreviewPanel.test.tsx` |

In the signing-gate suite, the assertion that carries the acceptance criterion
is always `expect(signTransaction).not.toHaveBeenCalled()`. Checking the thrown
error would not be enough: the wallet prompt is a side effect, and the only
honest way to prove it did not open is to prove the wallet API was never
invoked. Keep that assertion in any test added there.
