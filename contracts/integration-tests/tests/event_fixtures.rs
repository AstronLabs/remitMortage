//! Captures the events the contracts really emit during a full loan
//! lifecycle, for the backend's contract-event replay fixtures.
//!
//! Runs as a normal test (asserting the lifecycle emits the events the
//! backend indexes). With `REMIT_EVENT_FIXTURE_OUT` set it also writes the raw
//! events as XDR hex to that path; `npm run fixtures:contract-events` in
//! `backend/` converts that dump into the versioned fixture. See
//! docs/CONTRACT_EVENT_FIXTURES.md.

use escrow::{EscrowConfig, EscrowContract, EscrowContractClient};
use lending_pool::{LendingPoolContract, LendingPoolContractClient, LoanStatus, Tranche};
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token::StellarAssetClient,
    xdr::{Limits, ScVal, WriteXdr},
    Address, BytesN, Env, IntoVal, Symbol, TryFromVal, Val,
};

const USDC: i128 = 10_000_000;
const COMPOUND_PERIOD: u32 = 518_400;

struct CapturedEvent {
    contract: String,
    ledger: u32,
    topics: Vec<String>,
    data: String,
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn val_hex(env: &Env, val: &Val) -> String {
    let scval = ScVal::try_from_val(env, val).expect("event value converts to ScVal");
    to_hex(&scval.to_xdr(Limits::none()).expect("ScVal encodes to XDR"))
}

fn address_hex(env: &Env, address: &Address) -> String {
    let val: Val = address.into_val(env);
    val_hex(env, &val)
}

/// Records the events of each contract call together with the ledger it
/// ran in, the way an RPC `getEvents` poll would see them.
struct Recorder {
    previous: Vec<(String, Vec<String>, String)>,
    events: Vec<CapturedEvent>,
}

impl Recorder {
    fn new() -> Self {
        Self {
            previous: Vec::new(),
            events: Vec::new(),
        }
    }

    fn capture(&mut self, env: &Env) {
        let all: Vec<(String, Vec<String>, String)> = env
            .events()
            .all()
            .iter()
            .map(|(contract, topics, data)| {
                (
                    address_hex(env, &contract),
                    topics.iter().map(|t| val_hex(env, &t)).collect(),
                    val_hex(env, &data),
                )
            })
            .collect();
        // `all()` covers only the latest invocation in some SDK versions and
        // every invocation in others; keep just the events not seen before.
        let cumulative =
            all.len() >= self.previous.len() && all[..self.previous.len()] == self.previous[..];
        let start = if cumulative { self.previous.len() } else { 0 };
        for (contract, topics, data) in &all[start..] {
            self.events.push(CapturedEvent {
                contract: contract.clone(),
                ledger: env.ledger().sequence(),
                topics: topics.clone(),
                data: data.clone(),
            });
        }
        self.previous = all;
    }

    fn to_json(&self, contracts: &[(&str, String)]) -> String {
        let quote = |s: &str| format!("\"{s}\"");
        let roles: Vec<String> = contracts
            .iter()
            .map(|(role, hex)| format!("    {}: {}", quote(role), quote(hex)))
            .collect();
        let events: Vec<String> = self
            .events
            .iter()
            .map(|e| {
                let topics: Vec<String> = e.topics.iter().map(|t| quote(t)).collect();
                format!(
                    "    {{ \"contract\": {}, \"ledger\": {}, \"topics\": [{}], \"data\": {} }}",
                    quote(&e.contract),
                    e.ledger,
                    topics.join(", "),
                    quote(&e.data)
                )
            })
            .collect();
        format!(
            "{{\n  \"contracts\": {{\n{}\n  }},\n  \"events\": [\n{}\n  ]\n}}\n",
            roles.join(",\n"),
            events.join(",\n")
        )
    }
}

#[test]
fn capture_full_loan_lifecycle_events() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.min_persistent_entry_ttl = 3_000_000;
        li.min_temp_entry_ttl = 3_000_000;
        li.max_entry_ttl = 10_000_000;
    });

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();

    let escrow_id = env.register(EscrowContract, ());
    let escrow = EscrowContractClient::new(&env, &escrow_id);
    let pool_id = env.register(LendingPoolContract, ());
    let pool = LendingPoolContractClient::new(&env, &pool_id);
    pool.initialize(
        &admin, &token, &escrow_id, &800u32, &400u32, &treasury, &0u32, &0u32,
    );
    escrow.initialize(&EscrowConfig {
        admin: admin.clone(),
        token: token.clone(),
        lending_pool: pool_id.clone(),
        savings_target: 30_000 * USDC,
        max_duration_ledgers: 10_000_000,
        early_withdrawal_penalty_bps: 500,
        min_duration_ledgers: 0,
        penalty_bps_tier1: 500,
        penalty_bps_tier2: 400,
        penalty_bps_tier3: 300,
        penalty_bps_tier4: 200,
        grace_period_ledgers: 120_960,
        default_penalty_bps: 1_000,
        instance_bump_amount: 518_400,
        instance_lifetime_threshold: 129_600,
        persistent_bump_amount: 518_400,
        persistent_lifetime_threshold: 129_600,
        yield_vault: None,
        match_bps: 0,
        match_cap: 0,
        permissioned_mode: false,
    });

    let sac = StellarAssetClient::new(&env, &token);
    let borrower = Address::generate(&env);
    let investor = Address::generate(&env);
    let contractor = Address::generate(&env);
    let construction_fund = Address::generate(&env);
    let goal = Symbol::new(&env, "home_2026");
    sac.mint(&borrower, &(110_000 * USDC));
    sac.mint(&investor, &(70_000 * USDC));

    let mut rec = Recorder::new();
    rec.capture(&env);
    // Setup events (initialisation, mints) are not part of the lifecycle.
    rec.events.clear();

    pool.deposit(&investor, &(70_000 * USDC), &Tranche::Senior);
    rec.capture(&env);

    for month in 0..3 {
        if month > 0 {
            env.ledger()
                .set_sequence_number(env.ledger().sequence() + COMPOUND_PERIOD);
        }
        escrow.deposit(&borrower, &goal, &(10_000 * USDC));
        rec.capture(&env);
    }

    escrow.release(&borrower, &goal, &construction_fund);
    rec.capture(&env);

    let loan_id = BytesN::from_array(&env, &[7u8; 32]);
    pool.request_loan(&borrower, &loan_id, &(70_000 * USDC));
    rec.capture(&env);
    pool.approve_loan(&loan_id);
    rec.capture(&env);
    pool.add_contractor(&contractor);
    rec.capture(&env);
    pool.disburse(&loan_id, &contractor, &(30_000 * USDC));
    rec.capture(&env);
    pool.disburse(&loan_id, &contractor, &(40_000 * USDC));
    rec.capture(&env);

    env.ledger()
        .set_sequence_number(env.ledger().sequence() + COMPOUND_PERIOD);
    const INTEREST_SCALE: i128 = 1_000_000_000;
    let period_factor = INTEREST_SCALE + (800 * INTEREST_SCALE) / (10_000 * 12);
    let owed = 70_000 * USDC * period_factor / INTEREST_SCALE;
    pool.repay(&borrower, &loan_id, &owed);
    rec.capture(&env);
    assert_eq!(pool.get_loan_info(&loan_id).status, LoanStatus::Repaid);

    // The topics the backend indexer acts on must all be present.
    let topic_hex = |name: &str| val_hex(&env, &Symbol::new(&env, name).into_val(&env));
    for name in ["deposit", "disburse", "repay"] {
        let hex = topic_hex(name);
        assert!(
            rec.events.iter().any(|e| e.topics.first() == Some(&hex)),
            "lifecycle emitted no `{name}` event"
        );
    }

    if let Ok(path) = std::env::var("REMIT_EVENT_FIXTURE_OUT") {
        let contracts = [
            ("escrow", address_hex(&env, &escrow_id)),
            ("lendingPool", address_hex(&env, &pool_id)),
            ("token", address_hex(&env, &token)),
        ];
        if let Some(dir) = std::path::Path::new(&path).parent() {
            std::fs::create_dir_all(dir).expect("create event fixture dump directory");
        }
        std::fs::write(&path, rec.to_json(&contracts)).expect("write event fixture dump");
    }
}
