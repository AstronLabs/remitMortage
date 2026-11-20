// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Shared checker for the per-contract storage key tests.
//!
//! Every contract keeps its persistent / instance / temporary entries under
//! keys built from `#[contracttype]` enums. Two key variants that serialize to
//! the same bytes would silently overwrite each other's data, and nothing in
//! the compiler warns about it. Each contract therefore has a
//! `test_storage_keys.rs` that lists every key variant and hands the list to
//! [`assert_storage_keys`].
//!
//! This file lives outside any one crate and is mounted into each of them
//! (test builds only) with:
//!
//! ```ignore
//! #[cfg(test)]
//! #[path = "../../storage_key_check.rs"]
//! mod storage_key_check;
//! ```
//!
//! # What is checked
//!
//! 1. **Completeness.** The variants declared in the enum's source text must
//!    equal the variants listed in the test. Adding a variant without listing
//!    it fails the test.
//! 2. **No collisions.** No two listed keys serialize (XDR) to the same bytes.
//! 3. **Identifier vs. plain keys.** A variant that carries identifiers
//!    (addresses, ids, symbols, ...) never serializes to the same bytes as a
//!    variant that carries none, and no two variants anywhere in the contract
//!    share a name (which is the discriminant that starts every key).
//!
//! Storage is isolated per contract instance, so only keys within one contract
//! can collide; contracts are never checked against each other.

#![cfg(test)]
#![allow(dead_code)]

extern crate std;

use soroban_sdk::{xdr::ToXdr, Bytes, Env, IntoVal, Symbol, TryFromVal, Val, Vec as SorobanVec};
use std::{string::String, vec::Vec};

/// One listed key variant, with the key serialized the way storage sees it.
pub struct KeyCase {
    /// Name of the key enum (`DataKey`, ...).
    pub enum_name: &'static str,
    /// Name of the variant.
    pub variant: &'static str,
    /// Number of values the variant carries (0 for a plain variant).
    pub payload_len: u32,
    /// XDR of the full key. This is what must be unique.
    pub xdr: Bytes,
}

impl KeyCase {
    /// Whether the variant carries identifiers (address, id, symbol, ...).
    pub fn carries_id(&self) -> bool {
        self.payload_len > 0
    }
}

/// An empty list of key cases. Used by [`key_cases!`] so callers need no
/// `std` import in these `no_std` crates.
pub fn new_cases() -> Vec<KeyCase> {
    Vec::new()
}

/// Serializes `key` and records its shape.
pub fn key_case<T: IntoVal<Env, Val> + Clone>(
    env: &Env,
    enum_name: &'static str,
    variant: &'static str,
    key: T,
) -> KeyCase {
    let xdr = key.clone().to_xdr(env);
    let val: Val = key.into_val(env);

    // A `#[contracttype]` enum with payload variants serializes as a vec whose
    // first element is the variant's name as a symbol.
    let parts: SorobanVec<Val> = SorobanVec::try_from_val(env, &val)
        .unwrap_or_else(|_| panic!("{}::{} is not serialized as a vec", enum_name, variant));
    let tag = Symbol::try_from_val(env, &parts.get(0).expect("empty key"))
        .unwrap_or_else(|_| panic!("{}::{} has no symbol tag", enum_name, variant));
    assert!(
        tag == Symbol::new(env, variant),
        "{}::{} is listed under the wrong name",
        enum_name,
        variant
    );

    KeyCase {
        enum_name,
        variant,
        payload_len: parts.len() - 1,
        xdr,
    }
}

/// Lists key variants: `key_cases!(env, DataKey; Admin, Loan(id.clone()), ...)`.
///
/// Plain variants are written by name; variants that carry values are written
/// with sample values. The enum must be in scope at the call site.
macro_rules! key_cases {
    ($env:expr, $enum:ident; $( $v:ident $( ( $($arg:expr),+ $(,)? ) )? ),+ $(,)?) => {{
        let mut cases = $crate::storage_key_check::new_cases();
        $(
            cases.push($crate::storage_key_check::key_case(
                $env,
                stringify!($enum),
                stringify!($v),
                $enum::$v $( ( $($arg),+ ) )?,
            ));
        )+
        cases
    }};
}
#[allow(unused_imports)]
pub(crate) use key_cases;

/// Names of the variants declared in `enum <enum_name> { ... }` inside `src`.
///
/// Understands comments, attributes, tuple/struct payloads with generics and
/// explicit discriminants, which is everything the key enums use.
pub fn declared_variants(src: &str, enum_name: &str) -> Vec<String> {
    let clean = strip_line_comments(src);
    let bytes = clean.as_bytes();
    let needle = std::format!("enum {}", enum_name);

    let mut from = 0;
    while let Some(rel) = clean[from..].find(&needle) {
        let start = from + rel;
        let after = start + needle.len();
        from = after;

        let boundary_before = start == 0 || !is_ident_byte(bytes[start - 1]);
        let boundary_after = after >= bytes.len() || !is_ident_byte(bytes[after]);
        if !boundary_before || !boundary_after {
            continue;
        }
        let open = match clean[after..].find('{') {
            Some(i) => after + i,
            None => continue,
        };
        // Only whitespace between the name and the opening brace.
        if !clean[after..open].trim().is_empty() {
            continue;
        }
        return parse_variants(&clean[open + 1..]);
    }
    panic!("enum {} not found in the given source", enum_name);
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn strip_line_comments(src: &str) -> String {
    let mut out = String::new();
    for line in src.lines() {
        match line.find("//") {
            Some(i) => out.push_str(&line[..i]),
            None => out.push_str(line),
        }
        out.push('\n');
    }
    out
}

/// Parses the body of an enum (text after its opening `{`) up to the matching
/// `}` and returns the variant names.
fn parse_variants(body: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut depth: i32 = 0;
    let mut expect_name = true;
    let chars: Vec<char> = body.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '(' | '[' | '{' | '<' => depth += 1,
            ')' | ']' | '>' => depth -= 1,
            '}' => {
                if depth == 0 {
                    break;
                }
                depth -= 1;
            }
            ',' if depth == 0 => expect_name = true,
            c if depth == 0 && expect_name && (c.is_alphabetic() || c == '_') => {
                let mut name = String::new();
                while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                    name.push(chars[i]);
                    i += 1;
                }
                names.push(name);
                expect_name = false;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    names
}

/// Runs every check for one contract.
///
/// * `contract` — crate name, used in failure messages.
/// * `sources` — `(enum name, source text containing the enum)` for every
///   storage key enum the contract defines.
/// * `cases` — every variant of those enums, built with [`key_cases!`].
pub fn assert_storage_keys(contract: &str, sources: &[(&str, &str)], cases: &[KeyCase]) {
    // 1. Completeness: listed variants == declared variants, per enum.
    for case in cases {
        assert!(
            sources.iter().any(|(name, _)| *name == case.enum_name),
            "{}: {} is listed but its source was not provided",
            contract,
            case.enum_name
        );
    }
    for (enum_name, src) in sources {
        let declared = declared_variants(src, enum_name);
        assert!(
            !declared.is_empty(),
            "{}: found no variants in {}",
            contract,
            enum_name
        );
        let listed: Vec<&str> = cases
            .iter()
            .filter(|c| c.enum_name == *enum_name)
            .map(|c| c.variant)
            .collect();

        for name in &declared {
            assert!(
                listed.contains(&name.as_str()),
                "{}: {}::{} is declared but missing from the storage key test; add it to the list",
                contract,
                enum_name,
                name
            );
        }
        for name in &listed {
            assert!(
                declared.iter().any(|d| d == name),
                "{}: {}::{} is listed but no longer declared; remove it from the list",
                contract,
                enum_name,
                name
            );
        }
        for (n, name) in listed.iter().enumerate() {
            assert!(
                !listed[..n].contains(name),
                "{}: {}::{} is listed twice",
                contract,
                enum_name,
                name
            );
        }
    }

    // 2. No two keys serialize to the same bytes.
    for (a_idx, a) in cases.iter().enumerate() {
        for b in &cases[a_idx + 1..] {
            assert!(
                a.xdr != b.xdr,
                "{}: {}::{} and {}::{} serialize to the same storage key",
                contract,
                a.enum_name,
                a.variant,
                b.enum_name,
                b.variant
            );
        }
    }

    // 3a. A key carrying identifiers never equals a key carrying none.
    for id_key in cases.iter().filter(|c| c.carries_id()) {
        for plain in cases.iter().filter(|c| !c.carries_id()) {
            assert!(
                id_key.xdr != plain.xdr,
                "{}: {}::{} (carries identifiers) collides with {}::{}",
                contract,
                id_key.enum_name,
                id_key.variant,
                plain.enum_name,
                plain.variant
            );
        }
    }

    // 3b. Variant names are the discriminant that starts every key, so they
    // must be unique across all of a contract's key enums.
    for (a_idx, a) in cases.iter().enumerate() {
        for b in &cases[a_idx + 1..] {
            assert!(
                a.variant != b.variant,
                "{}: {}::{} and {}::{} share a name, so their keys share a discriminant",
                contract,
                a.enum_name,
                a.variant,
                b.enum_name,
                b.variant
            );
        }
    }
}
