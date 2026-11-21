"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import {
  WALLET_PROVIDER_LABELS,
  type ConnectedWallet,
  type WalletProviderId,
} from "../context/WalletContext";
import CopyValueButton from "./CopyValueButton";

const ALL_PROVIDERS: WalletProviderId[] = ["stellar", "ledger", "evm", "solana"];

function shorten(address: string) {
  return address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
}

export interface WalletAccountMenuProps {
  connectedWallets: ConnectedWallet[];
  /** Make a connected wallet the one used for the next signing action. */
  onSetActive: (provider: WalletProviderId) => void;
  /** Disconnect one wallet, leaving the others connected. */
  onDisconnect: (provider: WalletProviderId) => void;
  /** Connect handlers per provider; a provider without one is not offered. */
  connectors: Partial<Record<WalletProviderId, () => Promise<string | null>>>;
  isConnecting?: boolean;
  id?: string;
}

/**
 * Account menu listing every connected wallet side by side (issue #1117):
 * each wallet's address, which one is active for signing, a control to
 * switch the active wallet, a per-wallet disconnect, and buttons to connect
 * further providers without dropping the ones already connected.
 */
export default function WalletAccountMenu({
  connectedWallets,
  onSetActive,
  onDisconnect,
  connectors,
  isConnecting = false,
  id,
}: WalletAccountMenuProps) {
  const connected = new Set(connectedWallets.map((wallet) => wallet.provider));
  const available = ALL_PROVIDERS.filter((provider) => !connected.has(provider) && connectors[provider]);

  return (
    <div id={id} data-testid="wallet-account-menu" className="space-y-3 text-xs">
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Connected wallets
        </p>
        <ul className="space-y-2" aria-label="Connected wallets">
          {connectedWallets.map((wallet) => (
            <li
              key={wallet.provider}
              data-testid={`connected-wallet-${wallet.provider}`}
              className={`rounded-lg border p-2.5 ${
                wallet.isActive ? "border-cyan-500/40 bg-cyan-500/10" : "border-slate-700 bg-slate-900/60"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-200">{wallet.label}</span>
                {wallet.isActive ? (
                  <span
                    data-testid={`active-wallet-badge-${wallet.provider}`}
                    className="rounded-md border border-cyan-500/30 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cyan-300"
                  >
                    Active for signing
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onSetActive(wallet.provider)}
                    aria-label={`Use ${wallet.label} for signing`}
                    className="rounded-md border border-slate-600 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300 transition-colors hover:border-cyan-400/60 hover:text-cyan-200"
                  >
                    Use for signing
                  </button>
                )}
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <span
                  data-testid={`connected-wallet-address-${wallet.provider}`}
                  title={wallet.address}
                  className="truncate font-mono text-slate-300"
                >
                  {shorten(wallet.address)}
                </span>
                <CopyValueButton value={wallet.address} label={`${wallet.label} address`} />
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-cyan-400">
                  {wallet.usdcBalance != null ? `${wallet.usdcBalance} USDC` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => onDisconnect(wallet.provider)}
                  aria-label={`Disconnect ${wallet.label}`}
                  className="text-[11px] text-slate-400 underline underline-offset-2 transition-colors hover:text-red-400"
                >
                  Disconnect
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {available.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Connect another wallet
          </p>
          <div className="flex flex-wrap gap-1.5">
            {available.map((provider) => (
              <button
                key={provider}
                type="button"
                disabled={isConnecting}
                onClick={() => connectors[provider]?.()}
                aria-label={`Connect ${WALLET_PROVIDER_LABELS[provider]}`}
                className="rounded-md border border-slate-700 bg-slate-900/60 px-2 py-1 text-[11px] font-semibold text-slate-300 transition-colors hover:border-cyan-400/60 hover:text-cyan-200 disabled:opacity-50"
              >
                + {WALLET_PROVIDER_LABELS[provider]}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
