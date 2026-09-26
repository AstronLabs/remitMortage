// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { rpc } from "@stellar/stellar-sdk";

const DEFAULT_RPC_URL = "https://soroban-testnet.stellar.org";

let rpcServer: rpc.Server | null = null;

export function getRpcUrl(): string {
  return process.env.NEXT_PUBLIC_STELLAR_RPC_URL || DEFAULT_RPC_URL;
}

export function getRpcServer(): rpc.Server {
  if (!rpcServer) {
    rpcServer = new rpc.Server(getRpcUrl(), { allowHttp: getRpcUrl().startsWith("http://") });
  }
  return rpcServer;
}

export async function fetchTransactionStatus(
  hash: string
): Promise<rpc.Api.GetTransactionResponse> {
  const server = getRpcServer();
  return server.getTransaction(hash);
}

export const POLL_INTERVAL_MS = 2000;
