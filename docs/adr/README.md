# Architecture Decision Records

This directory records the significant, hard-to-reverse design decisions
behind this protocol — the ones whose reasoning otherwise only lives in a
pull request thread or in the memory of whoever made the call. If you are
about to re-debate one of the decisions below, read its ADR first: either
it has the reasoning you're about to re-derive, or it's genuinely out of
date and you've found something that should supersede it (see
`CONTRIBUTING.md`'s "Architecture Decision Records" section for how).

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-no-cross-contract-crate-dependencies.md) | Contracts never depend on each other's crates — only raw cross-contract calls | Accepted |
| [0002](0002-senior-junior-tranche-waterfall.md) | Senior/junior tranche waterfall with a seniority-order guard | Accepted |
| [0003](0003-off-chain-verification-on-chain-anchor.md) | Off-chain verification data, on-chain hash anchors only | Accepted |
| [0004](0004-contracttype-union-and-error-code-limits.md) | Splitting storage keys across a size limit, and manually-numbered error codes | Accepted |

## Adding a new ADR

1. Copy `template.md` to `NNNN-short-kebab-title.md`, where `NNNN` is the
   next unused 4-digit number (one more than the highest number in the
   table above).
2. Fill in every section — Status, Context, Decision, Consequences,
   Alternatives Considered.
3. Add a row to the table above in the same PR. `scripts/check-adr-format.mjs`
   (run in CI) fails the build if a new ADR file isn't linked here, or if
   a required section is missing.

See `CONTRIBUTING.md` for when a change needs an ADR at all, and how to
supersede an existing one.
