# ADR-0001: Contracts never depend on each other's crates — only raw cross-contract calls

## Status

Accepted

## Context

The protocol is split into several Soroban contracts (`lending-pool`,
`escrow`, `insurance-pool`, `verification-registry`, `multisig-validator`,
`governance`, `milestone`, and others), several of which need to call into
one another at runtime — `lending-pool`'s `disburse` skims an insurance
premium via the `insurance-pool` contract, `mark_default` calls the
escrow's `seize_collateral`, loan requests resolve an interest rate from
`verification-registry`, and restructuring approvals go through
`multisig-validator`.

The obvious way to call another contract's function from Rust is to add
that contract's crate as a Cargo dependency and call its exported function
directly, getting compile-time type checking for free. That is also the
wrong move here: every Soroban contract crate in this workspace is a full
`#[contract]` crate whose `#[contractimpl]` block exports its own
entrypoints (`get_admin`, `version`, `initialize`, and so on) as part of
the crate's public surface. If `lending-pool` depended on
`insurance-pool`'s crate, both crates' `#[contractimpl]`-generated
entrypoints would link into `lending-pool`'s own cdylib, and the two
contracts' same-named functions (`get_admin`, `version`, ...) would
collide at the WASM export level.

## Decision

No contract crate in `contracts/` depends on another contract's crate.
Every cross-contract call is made through the raw host functions
(`env.invoke_contract` for a call expected to always succeed, i.e. there is
no sensible recovery path, vs. `env.try_invoke_contract` when a failure
should become a typed error the caller can act on), constructing the
argument vector by hand and knowing the callee's entrypoint name and
signature out of band rather than through a generated typed client.

This is documented inline at the call sites themselves — the canonical
note lives above `premium_for` in `contracts/lending-pool/src/lib.rs`:

> Duplicated from `insurance_pool::PREMIUM_FEE_BPS` rather than depended
> on: insurance-pool is a full `#[contract]` crate, and Cargo-depending on
> it (or verification-registry / multisig-validator) here would link their
> `#[contractimpl]`-exported entrypoints into this crate's own cdylib,
> colliding on shared names like `get_admin`/`version` across contracts.
> Cross-contract calls below use raw `env.invoke_contract` instead, exactly
> like `mark_default`'s existing `seize_collateral` call.

A direct consequence: any constant or small piece of logic that two
contracts both need (e.g. the 5 bps insurance premium calculation that
both `lending-pool` and `insurance-pool` must agree on bit-for-bit) is
**duplicated** in both crates rather than imported from one, with a
comment at each copy pointing at the other and stating that the two must
stay numerically identical.

## Consequences

- Adding a new cross-contract call is more work than `some_crate::foo()`:
  the caller must hand-build the argument vector with `soroban_sdk::vec!`/
  `IntoVal`, know the callee's entrypoint name as a bare string (no
  compiler check that it exists or that the signature matches), and choose
  between `invoke_contract` (panics the whole transaction on failure) and
  `try_invoke_contract` (returns `Result`, must be handled).
- A typo in an entrypoint name or argument order is a runtime failure, not
  a compile error — there is no generated client type to catch it. New
  cross-contract calls should be tested against a real registered instance
  of the callee contract (see the `ZeroSeizureEscrow`/mock-contract pattern
  already used throughout the test suites), not assumed correct from
  reading the code.
- Shared constants/logic between two contracts (like `premium_for`) must
  be kept in sync by hand across both copies. Changing one side without
  the other is a silent correctness bug, not a compile error — any PR
  touching one copy should grep for the other and update it in the same
  change.
- Each contract crate can be built, versioned and deployed independently;
  no contract's WASM binary grows because of another contract's code.

## Alternatives Considered

- **Depend on the other contract's crate directly, for its types/constants
  only (not its `#[contract]`/`#[contractimpl]` items).** Rejected: Rust
  has no way to import "only the plain items" from a crate while excluding
  specific macro-generated code — pulling in the crate at all pulls in its
  `#[contractimpl]` block, which is exactly the part that collides.
  Splitting each contract into a "types" crate and an "entrypoints" crate
  was considered but rejected as disproportionate restructuring for the
  number of cross-contract calls actually needed.
- **A shared `common`/`protocol-types` crate holding only the duplicated
  constants and shared types.** This would remove the duplication
  (`premium_for`, the interest-rate tiers, etc.) without the collision
  risk, since a plain crate with no `#[contract]` item is safe to depend
  on from multiple contract crates. It remains the natural next step if
  the number of duplicated constants grows past the handful that exist
  today — not adopted yet because the current duplication is small and
  explicitly commented at every site, so the cost of introducing a new
  shared crate (another thing to version and keep WASM-size-neutral) was
  judged not yet worth it.
- **Soroban SDK's typed cross-contract client generation
  (`soroban_sdk::contractclient`) via a lightweight "interface-only" crate
  per contract** (a crate containing just the trait/interface, no
  `#[contract]` struct). This gives compile-time-checked calls without the
  collision risk and is the most promising long-term alternative; it was
  not adopted initially because it requires introducing one new crate per
  contract that is called into, which is more upfront restructuring than
  the raw-call approach for the original small set of cross-contract
  calls this protocol launched with.
