"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

// Contract Registry context.
//
// Central, app-wide source of truth for the yield parameters advertised by the
// deployed Soroban contracts (escrow savings APY, lending-pool tranche rates).
// UI that needs an "active interest rate" — the dashboard yield estimator, the
// savings card, the invest page — reads it from here rather than hard-coding a
// number, so a single configuration change propagates everywhere.
//
// Rates are configured through NEXT_PUBLIC_* environment variables (kept in
// step with the on-chain contract configuration) and fall back to the values
// the app has historically displayed. All rates are basis points (10,000 = 100%).

import React, { createContext, useContext, useMemo } from "react";

/** Yield parameters for a single registered contract entry. */
export interface ContractYieldParams {
  /** Stable key, e.g. "escrow" or "lending-pool-senior". */
  key: string;
  /** Human label for display. */
  label: string;
  /** Advertised annual yield in basis points (10,000 = 100%). */
  apyBps: number;
  /** Whether this contract is currently active/eligible for new deposits. */
  active: boolean;
}

export interface ContractRegistryValue {
  /** All registered contract yield entries. */
  contracts: ContractYieldParams[];
  /** Convenience: the active escrow savings APY in basis points. */
  escrowApyBps: number;
  /** Look up yield params by contract key. */
  getYieldParams: (key: string) => ContractYieldParams | undefined;
}

/** Default escrow APY (4.5%) — matches the figure shown on the savings card. */
const DEFAULT_ESCROW_APY_BPS = 450;
/** Default lending-pool senior tranche APY (4.0%). */
const DEFAULT_SENIOR_APY_BPS = 400;
/** Default lending-pool junior tranche APY (6.2%). */
const DEFAULT_JUNIOR_APY_BPS = 620;

/**
 * Parse a basis-point value from an environment string, ignoring blanks and
 * non-numeric input so a misconfigured var never yields NaN in the UI.
 */
function readBps(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const ContractRegistryContext = createContext<ContractRegistryValue | undefined>(
  undefined
);

export function ContractRegistryProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const value = useMemo<ContractRegistryValue>(() => {
    const escrowApyBps = readBps(
      process.env.NEXT_PUBLIC_ESCROW_APY_BPS,
      DEFAULT_ESCROW_APY_BPS
    );
    const seniorApyBps = readBps(
      process.env.NEXT_PUBLIC_SENIOR_APY_BPS,
      DEFAULT_SENIOR_APY_BPS
    );
    const juniorApyBps = readBps(
      process.env.NEXT_PUBLIC_JUNIOR_APY_BPS,
      DEFAULT_JUNIOR_APY_BPS
    );

    const contracts: ContractYieldParams[] = [
      {
        key: "escrow",
        label: "Escrow Savings Yield",
        apyBps: escrowApyBps,
        active: true,
      },
      {
        key: "lending-pool-senior",
        label: "Lending Pool — Senior",
        apyBps: seniorApyBps,
        active: true,
      },
      {
        key: "lending-pool-junior",
        label: "Lending Pool — Junior",
        apyBps: juniorApyBps,
        active: true,
      },
    ];

    const byKey = new Map(contracts.map((c) => [c.key, c]));

    return {
      contracts,
      escrowApyBps,
      getYieldParams: (key: string) => byKey.get(key),
    };
  }, []);

  return (
    <ContractRegistryContext.Provider value={value}>
      {children}
    </ContractRegistryContext.Provider>
  );
}

export function useContractRegistry(): ContractRegistryValue {
  const ctx = useContext(ContractRegistryContext);
  if (!ctx) {
    throw new Error(
      "useContractRegistry must be used within a ContractRegistryProvider"
    );
  }
  return ctx;
}

export default ContractRegistryContext;
