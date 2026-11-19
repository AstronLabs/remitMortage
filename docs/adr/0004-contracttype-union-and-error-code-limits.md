# ADR-0004: Splitting storage keys across a size limit, and manually-numbered error codes

## Status

Accepted

## Context

Two independent Soroban platform constraints showed up as real problems
during development, both in `contracts/lending-pool` (the contract with
the longest feature history and the largest `DataKey`/`PoolError` enums):

1. **A `#[contracttype]` enum (used for `DataKey`, the contract's storage
   key type) is capped at 50 variants by the Soroban host.** `DataKey` in
   `lending-pool` reached that ceiling as features accumulated — collateral
   tracking, loan portability, reward halving, fee switches, payoff
   quotes, and more, each needing their own key variant. Once at the
   ceiling, adding one more storage key variant to `DataKey` directly does
   not compile against the host's limit.
2. **`#[contracterror]` enums (`PoolError`, `EscrowError`, and similar)
   assign each variant an explicit `u32` discriminant by hand**, and the
   numbering has accumulated gaps and near-misses across many PRs adding
   variants independently (e.g. `PoolError`'s discriminants jump from 48
   to 50, skipping 49; `EscrowError`'s have been added out of numeric
   order as different features landed). There is no compiler check that a
   newly added variant's number doesn't collide with one added by a
   different, concurrently-developed PR.

## Decision

**Storage keys:** once `DataKey` is at or near the 50-variant ceiling, new
storage keys for newer features go into a second enum, `FeatureKey`
(`contracts/lending-pool/src/types.rs`), read and written through the same
`env.storage()` calls as `DataKey` — Soroban's storage API only needs the
key type to be a valid `#[contracttype]`, not any *specific* one, so a
second key enum works as a drop-in extension with no migration of
existing `DataKey` data. The type's own doc comment states the reason
directly:

> Storage keys for newer pool features. Kept apart from `DataKey` because
> Soroban caps a `#[contracttype]` union at 50 cases and `DataKey` is
> already at that ceiling.

Any new storage key added to `lending-pool` goes into `FeatureKey`, not
`DataKey`, from now on — `DataKey` is intentionally left at its current
ceiling rather than trimmed to make room, since removing an existing
variant to free a slot would require a storage migration for whatever
already uses that key, which is far riskier than simply starting a second
enum.

**Error codes:** each `#[contracterror]` enum's variants keep their
explicit `u32` values (required by the Soroban host — error codes must be
stable, small integers, not implicitly assigned, since they cross the
host/guest boundary as plain numbers a client has to match against).
When adding a new variant: read the enum's existing discriminants, pick
one strictly greater than the current maximum (ignore any gaps left by
earlier variants — reusing a gap risks colliding with a value some other
in-flight PR already claimed for a different purpose), and add it at the
bottom of the enum with a one-line doc comment. Do not renumber existing
variants to close a gap — their numeric values may already be depended on
by a deployed contract's error-matching client code, and Soroban error
codes are not required to be contiguous.

## Consequences

- A contributor adding a storage key to `lending-pool` must know to check
  `FeatureKey` as well as `DataKey` before assuming a variant doesn't
  exist yet, and must choose the right one of the two enums for a new key
  — this ADR is the thing that explains why there are two.
- The 50-variant ceiling will eventually bind `FeatureKey` too, at which
  point the same split happens again (a `FeatureKeyV2`, or whatever name
  fits) — this is an expected, repeatable pattern now, not a one-off fix.
- Error code collisions are prevented by review discipline (checking the
  current max before adding a variant), not by the compiler. A PR adding
  an error variant should be reviewed with the enum's full current list
  visible, specifically checking the new value against it — this is a
  real, recurring review burden this ADR makes explicit rather than
  implicit.
- Existing gaps in error-code numbering (e.g. `PoolError`'s missing 49)
  are permanent and intentionally not backfilled — a reviewer should not
  flag a gap as a bug to fix.

## Alternatives Considered

- **Shrink `DataKey` by removing rarely-used variants to make room.**
  Rejected: any variant still referenced by live on-chain storage cannot
  be removed without a data migration, which is far more operationally
  risky than adding a second enum — a migration can fail partway or be
  skipped on one deployed instance, silently losing data; a second enum
  cannot.
- **A single `DataKey` variant wrapping an inner, open-ended tag (e.g.
  `DataKey::Feature(Symbol)` keyed by an arbitrary runtime symbol) instead
  of a fixed enum.** This sidesteps the 50-case limit entirely by making
  the key space open-ended, but gives up the compiler's exhaustiveness
  checking on storage key handling (a `match` over `DataKey` today is
  guaranteed to handle every key; a `Symbol`-keyed scheme would not
  warn on a missing case) and makes every storage access a stringly-typed
  lookup instead of a checked variant. Rejected as a readability and
  safety regression for the sake of avoiding a second small enum.
- **Automatically assigned (non-explicit) error discriminants**, letting
  Rust number `#[contracterror]` variants implicitly in declaration
  order. Not viable: Soroban error codes are part of the contract's
  external interface — a client (frontend, another contract, a block
  explorer) matches on the numeric value, and implicit numbering means
  *reordering* existing variants (e.g. an unrelated alphabetical cleanup)
  would silently renumber every error after the reordered one, breaking
  every external matcher without a corresponding code change to review.
  Explicit numbers, despite the manual-review cost above, are the only
  way to keep error codes stable across refactors.
