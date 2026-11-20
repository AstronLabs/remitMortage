# Lending Pool contract

The pool takes investor deposits in two tranches, lends to borrowers against
milestone-based mortgages and distributes interest through a senior/junior
yield waterfall. Source is in [`src/`](src/); error codes are in
[`../../ERROR_CODES.md`](../../ERROR_CODES.md).

```bash
cd contracts
cargo test -p lending-pool
```

## Upgrade dry run

Run this **before proposing an upgrade**. Unit tests only see fresh state, so a
storage layout change that breaks loans already on chain would otherwise show up
only after deployment. The dry run deploys the wasm that is live today, builds
representative state with it, upgrades to the candidate wasm using the
contract's own `upgrade` and `migrate` calls, and checks that everything still
reads the same.

### Run it

From the repository root:

```bash
make upgrade-dry-run                      # baseline = origin/main
make upgrade-dry-run BASE_REF=v1.2.0      # baseline = any git ref, e.g. the deployed tag
BASE_WASM=./deployed.wasm make upgrade-dry-run   # baseline = a wasm file (e.g. downloaded from chain)
```

or call the script directly: `scripts/upgrade-dry-run.sh [BASE_REF]`.

It needs only the Rust toolchain pinned in
[`../rust-toolchain.toml`](../rust-toolchain.toml), which already includes the
`wasm32v1-none` target. The script then:

1. builds the **candidate** wasm from your working tree;
2. builds the **baseline** wasm from `BASE_REF` in a temporary git worktree
   (skipped when `BASE_WASM` is given); the first run compiles dependencies and
   takes a few minutes, later runs reuse
   `contracts/target/upgrade-dry-run-base`;
3. runs
   `cargo test -p lending-pool --test upgrade_dry_run -- --ignored --nocapture`
   with `UPGRADE_DRY_RUN_BASE_WASM` and `UPGRADE_DRY_RUN_CANDIDATE_WASM` set.

You can run step 3 yourself if you already have both wasm files.

### What it checks

The test is [`tests/upgrade_dry_run.rs`](tests/upgrade_dry_run.rs).

| Phase | What happens |
| --- | --- |
| Populate (baseline) | Investors in both tranches; loans that are approved and part repaid, fully repaid, requested (pending), rejected and cancelled; a queued tranche-cap change; interest compounded over a month. |
| Read | Every stored value is read through the contract's views: pool config and counters, tranche info, investor records, loans, repayment schedules, borrower counters. |
| Upgrade | The candidate wasm is uploaded and `upgrade` then `migrate` are called. |
| Compare | Every view must return **byte-identical XDR** (balances, loan status, counters, schedules), and every persistent ledger entry must be unchanged. `version` is the one value that must differ (+1). |
| Keep using | On the old state, the candidate repays a loan, pays principal, approves and disburses the pending loan and takes a new deposit, and pool liquidity must move by exactly the expected amount. |

Values are compared as serialized XDR, not as Rust types, so a layout change
fails the dry run even when field names still line up. The comparison is proven
to bite: `harness_detects_*` in the same file make sure a changed value or
entry fails it.

Not covered: defaulted loans (defaulting needs a live escrow contract), and
instance storage is compared through its views rather than raw, because
`upgrade` legitimately rewrites the contract instance.

### When your upgrade adds functions or storage

* **New function that touches existing state:** add a call to it in
  `exercise_old_state` in `tests/upgrade_dry_run.rs` (`pay_principal` is the
  example). This is what proves new code works on old state.
* **New stored value readable through a view:** add the view to `POOL_VIEWS`
  (zero-argument) or `read_state` (takes an id or address) so it is compared.
* **Intentional layout change:** the dry run is meant to fail. Write the
  migration in `migrate`, extend the test to populate state the baseline can
  hold, and assert the migrated result there instead of loosening the
  comparison.

A native self-check of the harness (`harness_scenario_runs_against_the_current_code`
and friends) runs in plain `cargo test`, so the scenario cannot rot between
upgrades; only the wasm-to-wasm run needs the command above.
