# Event Topic Naming Convention

Every contract event must follow one naming convention so the indexer, the
event-schema fixtures, and the generated catalog all agree (issue #857). The
convention is enforced mechanically: a conforming event cannot be merged, and a
non-conforming one fails CI before it can reach an indexer.

## The convention

An event is identified by a **topic symbol** plus zero or more literal
**sub-topic segments**. Both the topic symbol and each sub-topic segment MUST:

1. be `lower_snake_case`;
2. match `^[a-z][a-z0-9_]{0,31}$` — start with a letter, then letters, digits or
   underscores, at most 32 characters (the Soroban `Symbol` limit);
3. be stable: renaming a topic is a breaking change to the catalog and requires
   the dual-emit migration below.

The catalog key is the topic plus its literal sub-topics joined with `/`, e.g.
`dispute/raised`. Positional payload layouts are recorded next to the key in
`contracts/event-schemas/<contract>.json`; never reorder or remove a payload
field without a schema-version bump.

Examples that conform: `deposit`, `loan_approved`, `w_fulfil`, `dispute/raised`.

Examples that do **not**: `Deposit` (uppercase), `loan-approved` (hyphen),
`9lives` (leading digit), `a_very_long_event_name_that_exceeds_the_symbol_limit`.

## Enforcement

`contracts/event-schemas/schema.cjs` extracts events from each contract's Rust
source and compares them with the golden fixtures. Its `check` command now also
runs `conventionProblems()` over every extracted event and **exits non-zero on
any violation**:

```bash
node contracts/event-schemas/schema.cjs check
```

CI runs this in `.github/workflows/event-schema.yml` on every pull request that
touches the contracts, so a non-conforming new event fails the build. `update`
refuses to write a fixture for a non-conforming topic, so the bad name cannot be
grandfathered in either.

## Catalog

The published catalog is generated from the fixtures:

```bash
node contracts/event-schemas/schema.cjs catalog
```

This writes `contracts/event-schemas/CATALOG.md` (contract, event key, positional
topic and payload layout). Commit the regenerated catalog with any event change.
Do not edit it by hand.

## Dual-emit migration (renames)

A topic rename is a breaking change for indexers that key off the topic. During
the compatibility period, **emit both forms**:

```rust
// New canonical topic.
env.events().publish((symbol_short!("loan_ok"), loan_id), payload.clone());
// Legacy alias, retained until all consumers have migrated.
env.events().publish((symbol_short!("loan_approved"), loan_id), payload);
```

Rules for the migration:

- The new form is canonical; new consumers must only use it.
- The legacy form is recorded in the fixture and in the catalog so no consumer
  breaks silently.
- Remove the legacy emission in a follow-up release, and record the removal as a
  breaking schema change (`update --breaking "<reason>"`).

The mechanism for emitting both forms is ordinary `env.events().publish`; the
conformance gate validates both topic names, so the alias must also be
`lower_snake_case` and within the symbol limit.

## Why lower_snake_case

- It matches Soroban's idiomatic `symbol_short!` names and the existing catalog.
- It removes case- and separator-based ambiguity between `deposit` / `Deposit` /
  `DEPOSIT`, which otherwise decode to different topics for the same logical
  event.
- It gives the indexer a single, mechanically-checkable shape.
