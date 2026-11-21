#!/usr/bin/env -S npx tsx
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Regenerates the contract-event replay fixtures (issue #981).
 *
 * Converts the raw event dump written by the `event_fixtures` contract test
 * (which drives a full loan lifecycle through the real escrow and lending-pool
 * contracts) into the versioned fixture the backend replay tests load. The
 * script does not run cargo itself; run the contract test first.
 *
 * Usage (from backend/):
 *   npm run fixtures:contract-events                 # reads the default dump path
 *   npx tsx scripts/generate-contract-event-fixtures.ts --dump <file>
 *
 * See docs/CONTRACT_EVENT_FIXTURES.md for the full steps and when to run it.
 */

import fs from "node:fs";
import path from "node:path";
import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  CONTRACT_EVENT_FIXTURE_VERSION,
  type ContractEventFixture,
} from "../src/test-utils/contractEventFixture";

const DEFAULT_DUMP_PATH = path.resolve(
  __dirname,
  "../../contracts/target/event-fixtures/full-loan-lifecycle.dump.json"
);
const FIXTURE_PATH = path.resolve(
  __dirname,
  "../src/test-utils/fixtures/contract-events/full-loan-lifecycle.json"
);
const SOURCE_TEST = "contracts/integration-tests/tests/event_fixtures.rs";

interface RawDump {
  contracts: Record<string, string>;
  events: { contract: string; ledger: number; topics: string[]; data: string }[];
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
    regenerate: "see docs/CONTRACT_EVENT_FIXTURES.md",
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
  const dumpPath = flag >= 0 ? process.argv[flag + 1] : DEFAULT_DUMP_PATH;
  if (!dumpPath) {
    console.error("--dump needs a file path");
    process.exit(2);
  }
  if (!fs.existsSync(dumpPath)) {
    console.error(
      `No event dump at ${dumpPath}. Run the event_fixtures contract test first ` +
        "(see docs/CONTRACT_EVENT_FIXTURES.md)."
    );
    process.exit(1);
  }

  const fixture = convertDump(JSON.parse(fs.readFileSync(dumpPath, "utf8")));
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Wrote ${fixture.events.length} events to ${path.relative(process.cwd(), FIXTURE_PATH)}`);
}

if (require.main === module) main();
