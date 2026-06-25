"use client"

import React, { useState } from "react";
import { WalletProvider, useWallet } from "../context/WalletContext";

function shorten(pk: string) {
  return `${pk.slice(0, 6)}...${pk.slice(-4)}`;
}

const NAV_LINKS = [
  { href: "#how-it-works", label: "How It Works" },
  { href: "#features", label: "Features" },
  { href: "#stats", label: "Protocol" },
  { href: "/invest", label: "Invest" },
  { href: "/analytics", label: "Analytics" },
  { href: "/dashboard", label: "Dashboard" },
];

function InnerNavbar() {
  const { publicKey, isConnected, usdcBalance, connect, disconnect, wrongNetwork } = useWallet();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <>
      <nav className="fixed top-0 left-0 right-0 z-50 backdrop-blur-xl bg-[var(--bg-primary)]/80 border-b border-[var(--border-color)]">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          {/* Logo */}
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

          {/* Desktop nav links */}
          <div className="hidden md:flex items-center gap-8 text-sm text-[var(--text-secondary)]">
            <a href="#how-it-works" className="hover:text-[var(--text-primary)] transition-colors">How It Works</a>
            <a href="#features" className="hover:text-[var(--text-primary)] transition-colors">Features</a>
            <a href="#stats" className="hover:text-[var(--text-primary)] transition-colors">Protocol</a>
            <a href="/invest" className="hover:text-[var(--text-primary)] transition-colors">Invest</a>
            <a href="/dashboard" className="hover:text-[var(--text-primary)] transition-colors">Dashboard</a>
            <a href="/history" className="hover:text-[var(--text-primary)] transition-colors">History</a>
            {NAV_LINKS.map(({ href, label }) => (
              <a key={href} href={href} className="hover:text-[var(--text-primary)] transition-colors">
                {label}
              </a>
            ))}
          </div>

          {/* Desktop wallet */}
          <div className="hidden md:flex">
            <WalletButton isConnected={isConnected} publicKey={publicKey} usdcBalance={usdcBalance} connect={connect} disconnect={disconnect} />
          </div>

          {/* Mobile: wallet + hamburger */}
          <div className="flex md:hidden items-center gap-3">
            <WalletButton isConnected={isConnected} publicKey={publicKey} usdcBalance={usdcBalance} connect={connect} disconnect={disconnect} />
            <button
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              aria-controls="mobile-menu"
              onClick={() => setMenuOpen((prev) => !prev)}
              className="p-2 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card)] transition-colors"
            >
              {menuOpen ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5" aria-hidden="true">
                  <path d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </nav>

      {/* Overlay */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          aria-hidden="true"
          onClick={() => setMenuOpen(false)}
        />
      )}

      {/* Mobile slide-out drawer */}
      <div
        id="mobile-menu"
        role="dialog"
        aria-modal="true"
        aria-label="Mobile navigation"
        className={`fixed top-0 right-0 z-50 h-full w-72 bg-[var(--bg-primary)] border-l border-[var(--border-color)] flex flex-col pt-20 pb-8 px-6 md:hidden transition-transform duration-300 ease-in-out ${
          menuOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <nav className="flex flex-col gap-1">
          {NAV_LINKS.map(({ href, label }) => (
            <a
              key={href}
              href={href}
              onClick={() => setMenuOpen(false)}
              className="py-3 px-3 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card)] transition-colors text-base font-medium"
            >
              {label}
            </a>
          ))}
        </nav>
      </div>

      {wrongNetwork && (
        <div className="fixed top-16 left-0 right-0 z-40 bg-amber-100 text-amber-900 border-b border-amber-200 text-center py-2">
          You are connected to the wrong Stellar network. Please switch Freighter to Testnet.
        </div>
      )}
    </>
  );
}

interface WalletButtonProps {
  isConnected: boolean;
  publicKey: string | null;
  usdcBalance: string | null;
  connect: () => void;
  disconnect: () => void;
}

function WalletButton({ isConnected, publicKey, usdcBalance, connect, disconnect }: WalletButtonProps) {
  if (!isConnected) {
    return (
      <button onClick={connect} className="btn-primary !py-2.5 !px-5 !text-sm">
        Connect Wallet
      </button>
    );
  }
  return (
    <div className="flex items-center gap-3">
      <div className="text-sm text-[var(--text-secondary)]">{usdcBalance != null ? `${usdcBalance} USDC` : "—"}</div>
      <div className="px-3 py-1 rounded-md bg-[var(--bg-card)] border border-[var(--border-color)] text-sm">
        {publicKey ? shorten(publicKey) : "Connected"}
      </div>
      <button onClick={disconnect} className="btn-ghost text-sm">
        Disconnect
      </button>
    </div>
  );
}

export default function Navbar() {
  return (
    <WalletProvider>
      <InnerNavbar />
    </WalletProvider>
  );
}
