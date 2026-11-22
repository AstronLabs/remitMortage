# Contract CPU and Memory Budget Regression Tests

Soroban transactions have hard per-transaction limits (100,000,000 CPU
instructions and 40 MiB of memory on the network today). The `budget-tests`
crate measures every public contract entry point and fails when usage grows
past a tolerance or approaches those limits, so a refactor cannot quietly push a
function toward the limit.

```
contracts/budget-tests/
  src/lib.rs                      harness: measure, compare, table, coverage check
  tests/budget_regression/        one scenario module per contract
  budget-baselines.json           recorded CPU / memory per function
  budget-config.json              tolerance, network limits, exemptions
```

## Running

```bash
cd contracts
cargo test -p budget-tests -- --nocapture     # prints the budget table, then checks
```

Example output:

```
function                              cpu_insns      d_cpu    mem_bytes   cpu_lim   mem_lim  status
milestone::approve_milestone             150138      +0.0%        27907     0.15%     0.07%  ok
milestone::approve_milestone#worst       275794      +3.2%        93367     0.28%     0.22%  ok
yield-vault::process_withdrawal_queue#worst  15703940  +0.0%  5274880    15.70%    12.58%  ok
```

`d_cpu` is the change against the baseline, `cpu_lim` / `mem_lim` the share of
the network limit used.

## What a run checks

1. **Regression**: CPU or memory more than `tolerance_pct` (default 10%) above
   the baseline fails. Growth under `min_abs_cpu` / `min_abs_mem` is ignored so
   tiny functions do not flap. Improvements never fail.
2. **Network limit**: any measurement at or above `fail_pct` (80%) of a limit
   fails; at or above `warn_pct` (50%) it is flagged `WARN` in the table.
3. **Coverage**: every `pub fn` inside a `#[contractimpl]` block of a covered
   contract must have a scenario or an entry in `exemptions`. Adding a new
   public function without one fails the run, which is how new entry points get
   a baseline.
4. **Stale baselines**: a baseline whose scenario no longer exists fails.

## Scenarios

Each `tests/budget_regression/<contract>.rs` exposes `run(&mut Recorder)` and
wraps the call under test in `rec.measure("contract::function", &env, || ...)`.

- `contract::function` is the **representative** input.
- `contract::function#worst` (any `#label`) is a **worst-case** input: the
  largest signer/approver/token sets, longest queues and schedules, and long
  idle gaps the contract allows. These are what show real headroom.

When you add a public function, add a representative call (and a `#worst` call
if its cost scales with an input), then record its baseline (below).

### Covered contracts

`milestone`, `governance`, `insurance-pool`, `multisig-validator`,
`oracle-price`, `staking-pool`, `verification-registry`, `yield-vault`: every
public entry point has a baseline.

### Not covered yet

`lending-pool`, `escrow` and `bridge-adapter` do not compile in the workspace
today (the lending-pool `DataKey` enum exceeds the SDK's variant limit, which
also breaks `escrow` because it depends on `lending-pool`; `bridge-adapter`
references `BridgeError` variants that are missing). Their scenarios are opt-in
behind cargo features:

- `escrow`: scenarios written in `tests/budget_regression/escrow.rs` but not yet
  compiled or baselined. Enable with `--features escrow` once the crates build.
- `bridge-adapter`: no scenarios yet.
- `lending-pool`: full-coverage budget scenario is not wired into `budget-tests`
  because the crate's storage-key types (`DataKey`, `LoanRecord`, …) are private
  and cannot be constructed from outside the crate. Interest accrual — the
  hottest internal path — has a dedicated inline benchmark in
  `contracts/lending-pool/src/bench_accrual.rs` that runs under
  `cargo test --lib` (see "Lending-pool interest accrual benchmark" below).

When those crates compile again: add the scenario modules, add the contracts to
`CONTRACTS` in `main.rs`, make the features default, and record baselines. Until
then, changes to them are not budget-checked — except interest accrual, which
the inline benchmark covers.

## Intentionally updating baselines

When a legitimate increase is accepted (new feature, extra validation, a
deliberate trade-off):

```bash
cd contracts
BUDGET_UPDATE=1 cargo test -p budget-tests -- --nocapture
git diff budget-tests/budget-baselines.json
```

`BUDGET_UPDATE=1` rewrites `budget-baselines.json` from the current
measurements (still refusing anything near the network limit). Review the diff,
explain every increase over the tolerance in the PR description, and commit the
file with the code change. Do not update baselines to silence an unexplained
regression.

Other knobs in `budget-config.json`:

- `tolerance_pct`, `min_abs_cpu`, `min_abs_mem`, `warn_pct`, `fail_pct`: the
  thresholds above. Update `network_limits` if the network raises them.
- `exemptions`: `"contract::function"` (or a trailing `*` prefix such as
  `"contract::get_*"`) mapped to the reason it has no scenario. Use sparingly.
- `limit_exceptions`: exact keys that already exceed `fail_pct`, with the reason
  and the intended fix. They still go through the baseline regression check.
  Remove the entry once the function is fixed.

## Lending-pool interest accrual benchmark

Interest accrual (`LendingPoolContract::accrue_interest`) is the hottest
internal path in the lending pool — it runs on every repayment, disbursement,
refinance and default. Because the lending-pool's storage-key types are
private to the crate, the benchmark lives **inside** the lending-pool crate
(`src/bench_accrual.rs`) rather than in `budget-tests`, so it can call the
private function directly via `env.as_contract`.

```bash
# Run the benchmark (prints measured cost; fails on regression or limit breach)
cd contracts
cargo test -p lending-pool --lib bench_accrual -- --nocapture

# Record / re-record baselines after a deliberate cost change
cd contracts
BUDGET_UPDATE=1 cargo test -p lending-pool --lib bench_accrual -- --nocapture
```

`BUDGET_UPDATE=1` prints the measured CPU and memory for each scenario. Copy
the printed values into the `BASE_*` constants at the top of
`bench_accrual.rs`, explain every increase over the tolerance in the PR, and
commit them with the code change. Do not update baselines to silence an
unexplained regression.

Scenarios measured:

| key | loan age | payment history | why |
|-----|----------|-----------------|-----|
| `representative (1 period)` | 100 ledgers | fresh | typical one-period accrue |
| `mid-age (12 periods)` | 1 200 ledgers | fresh | one year of monthly compounding |
| `worst case (39k periods)` | 3 900 000 ledgers | fresh | longest gap within TTL; max `compound_pow` iterations |
| `after partial repayment` | 500 + 500 ledgers | half repaid | accrue on reduced balance after a payment |

The benchmark uses the same Soroban budget API as `budget-tests`
(`env.cost_estimate().budget()` → `cpu_instruction_cost()` /
`memory_bytes_cost()`). The tolerance (`15%`), minimum absolute growth
thresholds, and network-limit gate (`80%`) mirror `budget-config.json`. A zero
baseline skips the regression check until the first `BUDGET_UPDATE=1` run
records a real value; the network-limit gate is always on.

## Caveats

- Numbers come from the native (non-Wasm) test environment, so absolute values
  underestimate on-chain cost (no Wasm VM instantiation or execution). They are
  deterministic, which makes them reliable for *relative* change; leave extra
  headroom when comparing with a limit.
- Costs are per contract-call. Cross-contract calls inside a scenario use the
  real counterpart where it builds, otherwise a minimal mock (the milestone
  scenarios mock the lending pool), so cross-contract cost is approximate.
- `Env` ledger TTLs are raised in scenarios that jump millions of ledgers so
  entries are not archived mid-test.

## Current findings

- `multisig-validator::mark_missed_votes` costs O(expired ids x signers) with no
  cap on the id list; 30 ids x 50 signers is about 103% of the CPU limit. It is
  recorded as a `limit_exceptions` entry until the batch is capped or chunked.
- `oracle-price::update_price` with a 400-ledger TWAP window costs about 7% of
  the CPU limit per update, because every update rewrites and prunes the whole
  observation list.
- `staking-pool::unstake` with 25 supported tokens uses about 9.5% of the CPU
  limit; `yield-vault::process_withdrawal_queue` with 40 queued withdrawals uses
  about 16%.
- `lending-pool::accrue_interest` cost is tracked by the inline benchmark in
  `contracts/lending-pool/src/bench_accrual.rs`. Baselines are recorded with
  `BUDGET_UPDATE=1`; see "Lending-pool interest accrual benchmark" above.
