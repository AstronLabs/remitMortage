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

`npm run fixtures:contract-events` converts that recording into
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

Two steps, with the Rust toolchain installed. First run the capture test from
`contracts/`, pointing it at the dump path the converter reads by default:

```bash
REMIT_EVENT_FIXTURE_OUT="$PWD/target/event-fixtures/full-loan-lifecycle.dump.json" \
  cargo test --locked -p integration-tests --test event_fixtures -- --exact capture_full_loan_lifecycle_events
```

Then convert the dump from `backend/`:

```bash
npm run fixtures:contract-events
```

This rewrites the fixture. Run both steps and commit the result when:

- an escrow or lending pool event the indexer reads (`deposit`, `withdraw`,
  `disburse`, `repay`, `release`) changes its topics or data,
- the lifecycle in `event_fixtures.rs` changes,
- the fixture layout changes (bump `CONTRACT_EVENT_FIXTURE_VERSION` too).

A failing replay test after regenerating means the backend no longer decodes
what the contracts emit; fix the decoder rather than editing the fixture.

To convert a dump saved somewhere else, pass it directly:

```bash
npx tsx scripts/generate-contract-event-fixtures.ts --dump <file>
```

Related: [EVENT_SCHEMA_COMPATIBILITY.md](EVENT_SCHEMA_COMPATIBILITY.md) pins
event shapes from the Rust source; these fixtures pin real emitted values.
