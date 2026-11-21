// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Versioned event emission.
//!
//! Every event this contract publishes goes through [`emit_event`], which adds
//! the event's schema version as the **last topic**. Existing topics keep their
//! positions, so indexers that read `topics[0]` (the name) and `topics[1]` are
//! unaffected. Bump an event's version at its call site whenever its topics or
//! payload change; `contracts/event-schemas/schema.cjs check` fails if they
//! change without a bump.

use soroban_sdk::{Env, IntoVal, Val, Vec};

/// While `true`, each event is also published in its previous (unversioned)
/// shape so indexers can migrate. Set to `false` and remove the legacy
/// emission in the release after next.
pub const EMIT_LEGACY_EVENTS: bool = true;

/// Publishes an event with `version` appended to its topics, and, while
/// [`EMIT_LEGACY_EVENTS`] is set, again in the legacy shape.
pub fn emit_event<T, D>(env: &Env, version: u32, topics: T, data: D)
where
    T: IntoVal<Env, Vec<Val>>,
    D: IntoVal<Env, Val> + Clone,
{
    let legacy: Vec<Val> = topics.into_val(env);
    let mut versioned = legacy.clone();
    versioned.push_back(version.into_val(env));
    env.events().publish(versioned, data.clone());
    if EMIT_LEGACY_EVENTS {
        env.events().publish(legacy, data);
    }
}
