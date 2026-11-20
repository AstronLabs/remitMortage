// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Versioned contract-event fixture format (issue #981). Kept free of service
 * imports so the regeneration script can use it without loading the app.
 */

import fs from "fs";
import path from "path";

/** Bump when the fixture file layout changes; old files must be regenerated. */
export const CONTRACT_EVENT_FIXTURE_VERSION = 1;

export const CONTRACT_EVENT_FIXTURE_DIR = path.join(__dirname, "fixtures", "contract-events");

export interface ContractEventFixture {
  fixtureVersion: number;
  source: string;
  regenerate: string;
  contracts: { escrow: string; lendingPool: string; token: string };
  events: {
    contractId: string;
    ledger: number;
    /** First topic, for readable diffs. */
    name: string;
    /** Topics and value as base64 XDR ScVals, as Soroban RPC returns them. */
    topic: string[];
    value: string;
  }[];
}

export function loadContractEventFixture(name: string): ContractEventFixture {
  const file = path.join(CONTRACT_EVENT_FIXTURE_DIR, `${name}.json`);
  const fixture = JSON.parse(fs.readFileSync(file, "utf8")) as ContractEventFixture;
  if (fixture.fixtureVersion !== CONTRACT_EVENT_FIXTURE_VERSION) {
    throw new Error(
      `${name}.json is fixture version ${fixture.fixtureVersion}, expected ${CONTRACT_EVENT_FIXTURE_VERSION}. ` +
        "Run `npm run fixtures:contract-events` to regenerate it."
    );
  }
  return fixture;
}
