// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Horizon } from "@stellar/stellar-sdk";
import { ExplorerTransactionRecord } from "@/components/explorer/ExplorerTransactionDetails";

const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL ?? "https://horizon-testnet.stellar.org";

/**
 * Fetches a single transaction from Horizon for the explorer page. Returns
 * null (rather than throwing) on any lookup failure — including "not found"
 * and network errors — so the caller can render a 404 either way.
 */
export async function fetchTransaction(hash: string): Promise<ExplorerTransactionRecord | null> {
  try {
    const server = new Horizon.Server(HORIZON_URL);
    const tx = await server.transactions().transaction(hash).call();
    return {
      hash: tx.hash,
      ledger: tx.ledger_attr,
      createdAt: tx.created_at,
      sourceAccount: tx.source_account,
      feeCharged: String(tx.fee_charged),
      operationCount: tx.operation_count,
      memo: tx.memo,
      successful: tx.successful,
    };
  } catch {
    return null;
  }
}
