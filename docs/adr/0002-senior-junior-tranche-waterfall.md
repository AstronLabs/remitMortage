# ADR-0002: Senior/junior tranche waterfall with a seniority-order guard

## Status

Accepted

## Context

The lending pool funds borrower loans from pooled investor capital, and
investors have different risk appetites: some want the lowest possible
risk even at a lower return, others will accept more risk for more yield.
A single undifferentiated pool forces every investor into the same
risk/return point and cannot serve either group well.

Loans also default. When a loan defaults, *someone's* principal absorbs
the loss, and whoever absorbs first (the loss "waterfall" order) is the
single number that actually defines each investor class's real risk —
the advertised yield rate means little if the loss-absorption order isn't
also fixed and guaranteed.

## Decision

Investor capital is split into two tranches, `Tranche::Senior` and
`Tranche::Junior` (`contracts/lending-pool/src/types.rs`), with the
seniority relationship enforced in two independent places so a future
refactor cannot silently invert it in only one:

- **Yield priority (senior first).** On each `repay`, the interest portion
  of the payment is split so the senior tranche receives its fixed
  `senior_rate_bps` on its share of pool capital before the junior tranche
  receives whatever interest remains as its (higher, variable) yield. If
  there isn't enough interest in a given payment to cover senior's full
  fixed rate, junior simply receives less or nothing that cycle — senior's
  rate is a priority claim on available interest, not a guarantee
  independent of the pool's actual performance.
- **Loss priority (junior first).** On `mark_default`, the realized loss
  is absorbed by the junior tranche's capital up to its full deposited
  balance before any loss reaches the senior tranche
  (`junior_info.total_loss_absorbed` is filled first; only the overflow
  beyond junior's capacity reaches `senior_info.total_loss_absorbed` — see
  the loss-waterfall tests `test_loss_waterfall_junior_first` and
  `test_loss_waterfall_senior_absorbs_overflow`). A later recovery
  (`recover_default`) reverses the same order: it restores senior's
  absorbed loss first, then junior's.

This "senior gets paid first, junior loses first" pairing is what makes
the two tranches a genuine risk/return trade rather than two labels on the
same risk — the higher junior yield is priced as compensation for junior's
first-loss position, and the guard below exists specifically to keep that
trade honest as the code evolves.

**The seniority order is also enforced as an explicit runtime invariant**,
independent of the yield/loss logic itself:
`assert_waterfall_priority_order`, called on every `repay` that
distributes yield, panics (aborting the transaction) if the tranche
processing order it reads is not sorted senior-before-junior. The order
is read from `FeatureKey::WaterfallOrder`, which no production code path
ever writes — the guard's entire purpose is to let tests deliberately
inject a misordered list and confirm the invariant actually holds, so that
if a future refactor of the waterfall (or of how its order is derived)
ever reverses the sequence, it fails loudly and atomically rather than
silently paying junior ahead of senior.

## Consequences

- Investors choose their risk/return point at deposit time
  (`deposit(..., tranche: Tranche)`) and that choice determines both their
  yield formula and their position in the loss queue for as long as their
  capital is in the pool — the two can never be decoupled per-investor.
- Any change to how the waterfall computes or orders yield/loss
  distribution must keep `assert_waterfall_priority_order` passing, and
  that function's existence means such a change gets a hard runtime
  failure instead of a silently wrong distribution if it gets the order
  wrong — but only for the *ordering* invariant; it does not and cannot
  validate that the yield/loss *amounts* themselves are correct, which
  still depends on the arithmetic in `repay`/`mark_default` being right.
- Adding a third tranche (e.g. a "mezzanine" layer) means extending
  `Tranche`, `tranche_seniority_rank`, and the yield/loss split logic
  together — the guard will catch an inconsistent ordering between them
  but not a mismatch in the yield-share math.
- The waterfall only ever orders by this fixed rank, not by deposit time,
  size, or any other investor-specific attribute — two senior investors
  are always pari passu with each other.

## Alternatives Considered

- **A single undifferentiated pool (no tranches).** Simplest to implement
  and reason about, but forces every investor onto the same risk/return
  point, which does not match how real capital providers think about a
  lending pool — some will only invest at all if a safer, first-protected
  position exists. Rejected as not serving the investor base the protocol
  needs to attract.
- **More than two tranches at launch (e.g. senior/mezzanine/junior).**
  Gives finer risk granularity but multiplies the yield-split and
  loss-waterfall arithmetic's complexity and the number of invariants the
  guard has to check. Deferred until two tranches prove insufficient for
  real investor demand — adding a third tranche later is a type and logic
  extension, not a redesign, given the rank-based guard already in place.
- **Enforcing the seniority order only through the yield/loss formulas
  themselves, with no separate runtime guard.** This is strictly less
  code, but it means a future refactor that reorders the waterfall's
  internal processing (not necessarily the yield math itself) could
  invert senior/junior priority without any test failing unless that
  specific refactor happened to also break a yield-amount assertion.
  Rejected in favor of the explicit, independently-checkable invariant in
  `assert_waterfall_priority_order`, which is cheap to run and documents
  the invariant as a first-class thing the codebase protects, not an
  emergent property contributors have to rediscover.
