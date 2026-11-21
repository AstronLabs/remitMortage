// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Contract-event replay fixtures (issue #981).
 *
 * Fixtures are captured from the real contracts by
 * `npm run fixtures:contract-events`, so replay tests exercise the exact
 * topics and payloads the chain produces instead of hand-built events. This
 * module loads a fixture and feeds it through the backend's event indexer.
 */

import { xdr } from "@stellar/stellar-sdk";
import { SorobanEventIndexer } from "../services/eventIndexer.js";
import { decodeEvent, type EventFetcher, type NormalizedEvent } from "../services/eventListener.js";
import type { ContractEventFixture } from "./contractEventFixture.js";

export {
  CONTRACT_EVENT_FIXTURE_VERSION,
  loadContractEventFixture,
  type ContractEventFixture,
} from "./contractEventFixture.js";

/**
 * Decodes the events the indexer would receive. Like the RPC filter in
 * `createRpcFetcher`, only escrow and lending-pool events are passed on.
 */
export function decodeFixtureEvents(fixture: ContractEventFixture): NormalizedEvent[] {
  const watched = new Set([fixture.contracts.escrow, fixture.contracts.lendingPool]);
  return fixture.events
    .filter((event) => watched.has(event.contractId))
    .map((event) =>
      decodeEvent({
        contractId: event.contractId,
        topic: event.topic.map((t) => xdr.ScVal.fromXDR(t, "base64")),
        value: xdr.ScVal.fromXDR(event.value, "base64"),
        ledger: event.ledger,
      })
    );
}

/** An event source that serves the whole fixture in one batch, then nothing. */
export function fixtureFetcher(fixture: ContractEventFixture): EventFetcher {
  const events = decodeFixtureEvents(fixture);
  const latestLedger = Math.max(0, ...fixture.events.map((e) => e.ledger));
  let served = false;
  return async () => {
    if (served) return { events: [], cursor: null, latestLedger };
    served = true;
    return { events, cursor: `fixture-${latestLedger}`, latestLedger };
  };
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Runs one indexer poll over the fixture and resolves once it has stopped. */
export async function replayContractEvents(
  fixture: ContractEventFixture,
  options: { logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void } } = {}
): Promise<void> {
  // The indexer sleeps after every poll (or after an error); stopping there
  // makes the replay exactly one pass.
  const indexer: SorobanEventIndexer = new SorobanEventIndexer({
    fetcher: fixtureFetcher(fixture),
    escrowContractId: fixture.contracts.escrow,
    lendingPoolContractId: fixture.contracts.lendingPool,
    logger: options.logger ?? silentLogger,
    sleep: async () => indexer.stop(),
  });
  indexer.start();
  await indexer.waitForStop();
}
