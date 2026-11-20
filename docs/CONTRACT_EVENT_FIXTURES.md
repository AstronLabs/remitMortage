# Contract Event Replay Fixtures

Backend integration tests used to build contract events by hand, so they could
drift from what the contracts really emit. Replay fixtures are captured from
the contracts themselves and fed through the backend's event indexer.

## What is captured

`contracts/integration-tests/tests/event_fixtures.rs` drives a full loan
lifecycle through the real escrow and lending pool contracts (pool funding,
three escrow deposits, release, loan request and approval, two milestone
disbursements, full repayment) and records every event with the ledger it ran
in.

`npm run fixtures:contract-events` turns that recording into
`backend/src/test-utils/fixtures/contract-events/full-loan-lifecycle.json`.
Each event keeps its topics and value as base64 XDR, exactly as Soroban RPC
returns them, plus a readable `name`. The file carries a `fixtureVersion`; the
loader refuses a file whose version does not match
`CONTRACT_EVENT_FIXTURE_VERSION`.

## How tests use it

`backend/src/test-utils/contractEventReplay.ts` loads a fixture, keeps only
escrow and lending pool events (as the RPC filter does), decodes them with the
indexer's `decodeEvent`, and runs one `SorobanEventIndexer` poll over them.
`backend/src/__tests__/contractEventReplay.test.ts` replays the lifecycle and
checks the resulting borrower balances, event rows and indexer state.

## Regenerating

From `backend/`, with the Rust toolchain installed:

```bash
npm run fixtures:contract-events
```

This runs the capture test with `cargo test` and rewrites the fixture. Run it
and commit the result when:

- an escrow or lending pool event the indexer reads (`deposit`, `withdraw`,
  `disburse`, `repay`, `release`) changes its topics or data,
- the lifecycle in `event_fixtures.rs` changes,
- the fixture layout changes (bump `CONTRACT_EVENT_FIXTURE_VERSION` too).

A failing replay test after regenerating means the backend no longer decodes
what the contracts emit; fix the decoder rather than editing the fixture.

To convert an existing dump without running cargo, pass it directly:

```bash
npx tsx scripts/generate-contract-event-fixtures.ts --dump <file>
```

Related: [EVENT_SCHEMA_COMPATIBILITY.md](EVENT_SCHEMA_COMPATIBILITY.md) pins
event shapes from the Rust source; these fixtures pin real emitted values.
