"use client"

import React from "react";
import { WalletProvider, useWallet } from "../context/WalletContext";

function shorten(pk: string) {
  return `${pk.slice(0, 6)}...${pk.slice(-4)}`;
}

function InnerNavbar() {
  const { publicKey, isConnected, usdcBalance, connect, disconnect, wrongNetwork } = useWallet();

  return (
    <>
      <nav className="fixed top-0 left-0 right-0 z-50 backdrop-blur-xl bg-[var(--bg-primary)]/80 border-b border-[var(--border-color)]">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-cyan-500 flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                <path d="M3 21h18" />
                <path d="M5 21V7l7-4 7 4v14" />
              </svg>
            </div>
            <span className="text-lg font-bold tracking-tight">
              Remit<span className="text-[var(--accent-primary-light)]">Mortgage</span>
            </span>
          </div>

          <div className="hidden md:flex items-center gap-8 text-sm text-[var(--text-secondary)]">
            <a href="#how-it-works" className="hover:text-[var(--text-primary)] transition-colors">How It Works</a>
            <a href="#features" className="hover:text-[var(--text-primary)] transition-colors">Features</a>
            <a href="#stats" className="hover:text-[var(--text-primary)] transition-colors">Protocol</a>
            <a href="/invest" className="hover:text-[var(--text-primary)] transition-colors">Invest</a>
            <a href="/dashboard" className="hover:text-[var(--text-primary)] transition-colors">Dashboard</a>
          </div>

          <div>
            {!isConnected ? (
              <button onClick={() => connect()} className="btn-primary !py-2.5 !px-5 !text-sm">
                Connect Wallet
              </button>
            ) : (
              <div className="flex items-center gap-3">
                <div className="text-sm text-[var(--text-secondary)]">{usdcBalance != null ? `${usdcBalance} USDC` : "—"}</div>
                <div className="px-3 py-1 rounded-md bg-[var(--bg-card)] border border-[var(--border-color)] text-sm">
                  {publicKey ? shorten(publicKey) : "Connected"}
                </div>
                <button onClick={() => disconnect()} className="btn-ghost text-sm">
                  Disconnect
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      {wrongNetwork && (
        <div className="fixed top-16 left-0 right-0 z-40 bg-amber-100 text-amber-900 border-b border-amber-200 text-center py-2">
          You are connected to the wrong Stellar network. Please switch Freighter to Testnet.
        </div>
      )}
    </>
  );
}

export default function Navbar() {
  return (
    <WalletProvider>
      <InnerNavbar />
    </WalletProvider>
  );
}
