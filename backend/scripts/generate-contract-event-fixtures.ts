#!/usr/bin/env -S npx tsx
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Regenerates the contract-event replay fixtures (issue #981).
 *
 * Runs the `event_fixtures` contract test, which drives a full loan lifecycle
 * through the real escrow and lending-pool contracts and dumps every event
 * they emit, then rewrites that dump as the versioned fixture the backend
 * replay tests load.
 *
 * Usage (from backend/):
 *   npm run fixtures:contract-events
 *   npx tsx scripts/generate-contract-event-fixtures.ts --dump <file>   # skip cargo, convert an existing dump
 *
 * See docs/CONTRACT_EVENT_FIXTURES.md for when to run it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  CONTRACT_EVENT_FIXTURE_VERSION,
  type ContractEventFixture,
} from "../src/test-utils/contractEventFixture";

const CONTRACTS_DIR = path.resolve(__dirname, "../../contracts");
const FIXTURE_PATH = path.resolve(
  __dirname,
  "../src/test-utils/fixtures/contract-events/full-loan-lifecycle.json"
);
const SOURCE_TEST = "contracts/integration-tests/tests/event_fixtures.rs";

interface RawDump {
  contracts: Record<string, string>;
  events: { contract: string; ledger: number; topics: string[]; data: string }[];
}

function runContractTest(): string {
  const dump = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "remit-events-")), "dump.json");
  const result = spawnSync(
    "cargo",
    [
      "test",
      "--locked",
      "-p",
      "integration-tests",
      "--test",
      "event_fixtures",
      "--",
      "--exact",
      "capture_full_loan_lifecycle_events",
    ],
    { cwd: CONTRACTS_DIR, env: { ...process.env, REMIT_EVENT_FIXTURE_OUT: dump }, stdio: "inherit" }
  );
  if (result.status !== 0 || !fs.existsSync(dump)) {
    throw new Error("cargo test for event_fixtures failed; no event dump was written");
  }
  return dump;
}

const scVal = (hex: string) => xdr.ScVal.fromXDR(hex, "hex");
const contractId = (hex: string) => Address.fromScVal(scVal(hex)).toString();

export function convertDump(raw: RawDump): ContractEventFixture {
  const contracts = Object.fromEntries(
    Object.entries(raw.contracts).map(([role, hex]) => [role, contractId(hex)])
  ) as ContractEventFixture["contracts"];

  return {
    fixtureVersion: CONTRACT_EVENT_FIXTURE_VERSION,
    source: SOURCE_TEST,
    regenerate: "npm run fixtures:contract-events (from backend/)",
    contracts,
    events: raw.events.map((event) => {
      const topics = event.topics.map(scVal);
      return {
        contractId: contractId(event.contract),
        ledger: event.ledger,
        name: topics.length > 0 ? String(scValToNative(topics[0])) : "",
        topic: topics.map((t) => t.toXDR("base64")),
        value: scVal(event.data).toXDR("base64"),
      };
    }),
  };
}

function main() {
  const flag = process.argv.indexOf("--dump");
  const dumpPath = flag >= 0 ? process.argv[flag + 1] : runContractTest();
  if (!dumpPath) {
    console.error("--dump needs a file path");
    process.exit(2);
  }

  const fixture = convertDump(JSON.parse(fs.readFileSync(dumpPath, "utf8")));
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Wrote ${fixture.events.length} events to ${path.relative(process.cwd(), FIXTURE_PATH)}`);
}

if (require.main === module) main();
