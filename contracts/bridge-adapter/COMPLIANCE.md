# BridgeAdapter compliance suite

`src/compliance.rs` ships a generic, interface-level test suite that verifies a
`BridgeAdapter` implementation honors the lock/mint/burn contract. It drives the
adapter **through the trait only** (`crate::BridgeAdapter`), never through a
concrete type's inherent API, so the same suite runs unchanged against any
implementation.

## Invariants asserted

1. A lock records exactly the locked amount and does not mint.
2. Minting the resulting operation records exactly the locked amount, so
   `total_locked == total_minted` after a full cycle.
3. Re-minting the same operation is refused with `AlreadyProcessed` (no
   double-mint).
4. Burning returns exactly the locked collateral, so after the cycle
   `total_burned == total_locked`.
5. `verify_signature` rejects an operation that does not exist.

## Running it against a new adapter

1. Depend on this crate with the `compliance-tests` feature (which turns on the
   SDK test utilities the suite needs):

   ```toml
   [dev-dependencies]
   bridge-adapter = { path = "../bridge-adapter", features = ["compliance-tests"] }
   ```

2. Deploy and initialize your adapter, then hand the suite a setup closure:

   ```rust
   use bridge_adapter::compliance::assert_adapter_compliance;
   use soroban_sdk::{testutils::Address as _, Address, Env};

   #[test]
   fn my_adapter_is_compliant() {
       let env = Env::default();
       let admin = Address::generate(&env);
       assert_adapter_compliance::<MyAdapter, _>(&env, move |env| {
           let contract_id = env.register(MyAdapter, ());
           let client = MyAdapterClient::new(env, &contract_id);
           client.initialize(&admin, /* min */, /* max */, /* chains incl. ethereum */);
           contract_id
       });
   }
   ```

`setup` receives the `Env` and must:

- deploy an instance of the adapter and return its contract address;
- initialize it with `min_lock_amount <= COMPLIANCE_AMOUNT` and
  `max_lock_amount >= COMPLIANCE_AMOUNT` (both defined in `compliance.rs`);
- include `ethereum` in the supported destination chains;
- grant the test caller any wrapped-asset balance or permission the adapter
  requires, since the suite calls `mock_all_auths` but does not pre-fund.

## Reference

The shipped `StellarBridgeAdapter` stub is verified by
`stub_adapter_passes_the_shared_compliance_suite` in `src/test.rs`, proving the
suite is reusable and currently passing.
