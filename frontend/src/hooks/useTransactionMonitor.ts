"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "@stellar/stellar-sdk";
import { fetchTransactionStatus, POLL_INTERVAL_MS } from "../lib/soroban-rpc";
import {
  extractContractError,
  extractGasFee,
  extractSenderAddress,
  formatTransactionLogs,
  isTerminalPhase,
  mapToUiPhase,
  type TxUiPhase,
} from "../lib/transaction-status";

export type TransactionMonitorState = {
  phase: TxUiPhase;
  pollCount: number;
  isPolling: boolean;
  rpcResponse: rpc.Api.GetTransactionResponse | null;
  senderAddress: string | null;
  gasFee: string | null;
  contractError: string | null;
  logs: Record<string, unknown>;
  pollError: string | null;
};

const INITIAL_STATE: TransactionMonitorState = {
  phase: "submitted",
  pollCount: 0,
  isPolling: true,
  rpcResponse: null,
  senderAddress: null,
  gasFee: null,
  contractError: null,
  logs: { status: "initializing" },
  pollError: null,
};

export function useTransactionMonitor(hash: string | undefined) {
  const [state, setState] = useState<TransactionMonitorState>(INITIAL_STATE);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const poll = useCallback(async () => {
    if (!hash) return;

    try {
      const response = await fetchTransactionStatus(hash);
      pollCountRef.current += 1;
      const pollCount = pollCountRef.current;
      const phase = mapToUiPhase(response.status, pollCount);
      const senderAddress = extractSenderAddress(response);
      const gasFee = extractGasFee(response);
      const contractError =
        response.status === rpc.Api.GetTransactionStatus.FAILED
          ? extractContractError(response)
          : null;

      setState({
        phase,
        pollCount,
        isPolling: !isTerminalPhase(phase),
        rpcResponse: response,
        senderAddress,
        gasFee,
        contractError,
        logs: formatTransactionLogs(response, pollCount, phase),
        pollError: null,
      });

      if (isTerminalPhase(phase)) {
        stopPolling();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to poll transaction status";
      setState((prev) => ({
        ...prev,
        pollError: message,
        isPolling: false,
      }));
      stopPolling();
    }
  }, [hash, stopPolling]);

  useEffect(() => {
    if (!hash) return;

    pollCountRef.current = 0;
    setState(INITIAL_STATE);

    void poll();
    intervalRef.current = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);

    return () => {
      stopPolling();
    };
  }, [hash, poll, stopPolling]);

  return state;
}
