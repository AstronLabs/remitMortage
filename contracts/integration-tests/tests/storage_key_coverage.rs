// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Workspace-wide guard for the storage key collision tests.
//!
//! Each contract crate has a `src/test_storage_keys.rs` that lists its key
//! variants (see `contracts/storage_key_check.rs`). This test makes sure no
//! contract is skipped:
//!
//! * every workspace member has such a test, unless it is on the short
//!   [`NO_CONTRACT_STORAGE`] list;
//! * every `#[contracttype]` key enum (name ending in `Key`) defined in a
//!   member's non-test sources is named in that member's test.
//!
//! It also checks the checker itself: a missing variant and a colliding
//! variant must both make it fail.

use std::{fs, path::Path};

#[path = "../../storage_key_check.rs"]
mod storage_key_check;

use soroban_sdk::{contracttype, Env};
use storage_key_check::{assert_storage_keys, declared_variants, key_cases};

/// Workspace members that define no contract storage, so have nothing to list.
const NO_CONTRACT_STORAGE: &[&str] = &["budget-tests", "integration-tests"];

fn contracts_dir() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("integration-tests sits inside contracts/")
}

fn workspace_members() -> Vec<String> {
    let manifest = fs::read_to_string(contracts_dir().join("Cargo.toml")).unwrap();
    let start = manifest.find("members").expect("workspace members");
    let open = start + manifest[start..].find('[').unwrap();
    let close = open + manifest[open..].find(']').unwrap();
    manifest[open + 1..close]
        .split(',')
        .map(|m| m.trim().trim_matches('"').to_string())
        .filter(|m| !m.is_empty())
        .collect()
}

fn rust_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().map_or(false, |e| e == "rs") {
            out.push(path);
        }
    }
}

/// Test-only support files that may define throwaway key enums.
fn is_test_file(path: &Path) -> bool {
    let name = path.file_name().unwrap().to_string_lossy();
    name.starts_with("test")
        || name.starts_with("fuzz")
        || name.contains("_tests")
        || name == "state_machine.rs"
}

/// Names of `#[contracttype] enum *Key` declarations in `src`, ignoring
/// anything from an inline `#[cfg(test)] mod test(s)` onwards.
fn key_enums(src: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut pending_contracttype = false;
    let mut pending_cfg_test = false;

    for line in src.lines() {
        let t = line.trim();
        if t.starts_with("mod test") && pending_cfg_test {
            break;
        }
        if t == "#[cfg(test)]" {
            pending_cfg_test = true;
            continue;
        }
        if t == "#[contracttype]" {
            pending_contracttype = true;
            continue;
        }
        if t.is_empty() || t.starts_with("//") || t.starts_with("#[") {
            continue;
        }
        if let Some(pos) = t.find("enum ") {
            let name: String = t[pos + 5..]
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if pending_contracttype && name.ends_with("Key") {
                found.push(name);
            }
        }
        pending_contracttype = false;
        pending_cfg_test = false;
    }
    found
}

#[test]
fn test_every_contract_has_a_storage_key_test() {
    let members = workspace_members();
    assert!(members.len() > 5, "failed to read the workspace members");

    for member in members {
        if NO_CONTRACT_STORAGE.contains(&member.as_str()) {
            continue;
        }
        let src_dir = contracts_dir().join(&member).join("src");
        let test_path = src_dir.join("test_storage_keys.rs");
        let test_src = fs::read_to_string(&test_path).unwrap_or_else(|_| {
            panic!(
                "{member}: missing src/test_storage_keys.rs (add one, or add the \
                 crate to NO_CONTRACT_STORAGE if it defines no contract storage)"
            )
        });

        let mut files = Vec::new();
        rust_files(&src_dir, &mut files);

        let mut defined = Vec::new();
        for file in files.iter().filter(|f| !is_test_file(f)) {
            defined.extend(key_enums(&fs::read_to_string(file).unwrap()));
        }
        assert!(
            !defined.is_empty(),
            "{member}: no storage key enum found; if it has no contract storage, \
             add it to NO_CONTRACT_STORAGE"
        );
        for name in defined {
            assert!(
                test_src.contains(&format!("\"{name}\"")),
                "{member}: key enum {name} is not covered by src/test_storage_keys.rs"
            );
        }
    }
}

// ── The checker itself ──────────────────────────────────────────────────

#[test]
fn test_variant_parser_reads_all_declaration_forms() {
    let src = r#"
        /// Docs mention enum Key { Fake } and are ignored.
        #[contracttype]
        #[derive(Clone)]
        pub enum Key {
            /// A plain variant.
            Config,
            Loan(BytesN<32>), // trailing comment
            #[allow(dead_code)]
            Pair(Address, Map<Symbol, u32>),
            Fee { bps: u32, cap: i128 },
            Last = 4,
        }
        enum KeyOther { Nope }
    "#;
    assert_eq!(
        declared_variants(src, "Key"),
        ["Config", "Loan", "Pair", "Fee", "Last"]
    );
}

#[contracttype]
#[derive(Clone)]
enum KeyA {
    Admin,
    Loan(u32),
}

#[contracttype]
#[derive(Clone)]
enum KeyB {
    Admin,
    Total,
}

const KEY_SRC: &str = "
    enum KeyA { Admin, Loan(u32) }
    enum KeyB { Admin, Total }
";

#[test]
fn test_checker_accepts_a_complete_non_colliding_list() {
    let env = Env::default();
    let cases = key_cases!(&env, KeyA; Admin, Loan(1u32));
    assert_storage_keys("fake", &[("KeyA", KEY_SRC)], &cases);
}

#[test]
#[should_panic(expected = "serialize to the same storage key")]
fn test_checker_rejects_a_colliding_variant() {
    let env = Env::default();
    // KeyA::Admin and KeyB::Admin are the same bytes in storage.
    let mut cases = key_cases!(&env, KeyA; Admin, Loan(1u32));
    cases.extend(key_cases!(&env, KeyB; Admin, Total));
    assert_storage_keys("fake", &[("KeyA", KEY_SRC), ("KeyB", KEY_SRC)], &cases);
}

#[test]
#[should_panic(expected = "declared but missing from the storage key test")]
fn test_checker_rejects_a_variant_missing_from_the_list() {
    let env = Env::default();
    // `Loan` is declared in the source but not listed.
    let cases = key_cases!(&env, KeyA; Admin);
    assert_storage_keys("fake", &[("KeyA", KEY_SRC)], &cases);
}
