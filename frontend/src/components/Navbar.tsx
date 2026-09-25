"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useWallet } from "../context/WalletContext";
import { useNotifications } from "@/context/NotificationContext";
import { useKeyboardShortcuts } from "@/context/KeyboardShortcutsContext";
import { describeNetworkMismatch } from "../lib/wallet-errors";
import { LocaleSwitcher } from "@/i18n/LocaleSwitcher";
import { ChevronDown, Landmark, Menu, X, Keyboard } from "lucide-react";

function shorten(pk: string) {
  return `${pk.slice(0, 6)}...${pk.slice(-4)}`;
}

const PRIMARY_LINKS = [
  { href: "/verify", labelKey: "verify" },
  { href: "/application", labelKey: "application" },
];

const FINANCE_LINKS = [
  { href: "/invest", labelKey: "invest" },
  { href: "/repay", labelKey: "repay" },
];

const OPERATIONS_LINKS = [
  { href: "/contractor", labelKey: "contractor" },
  { href: "/governance", labelKey: "governance" },
  { href: "/history", labelKey: "history" },
  { href: "/gas-optimization", labelKey: "gasOptimizer" },
  { href: "/identity", labelKey: "identity" },
  { href: "/protocol", labelKey: "protocol" },
];

function InnerNavbar() {
  const {
    publicKey,
    isConnected,
    usdcBalance,
    connect,
    disconnect,
    wrongNetwork,
    network,
    walletType,
    walletError,
    clearError,
    isConnecting,
  } = useWallet();
  const { unreadCount, togglePanel } = useNotifications();
  const { openCheatSheet } = useKeyboardShortcuts();
  const t = useTranslations("nav");
  // usePathname() can return null (e.g. outside an active route render), and
  // every active-link check below does pathname.startsWith(...).
  const pathname = usePathname() ?? "";
  const [menuOpen, setMenuOpen] = useState(false);

  const showDisconnectNotice = !!walletError && !isConnected;
  const noticeOffset = wrongNetwork ? (showDisconnectNotice ? "6.75rem" : "5rem") : "5rem";

  return (
    <>
      <header role="banner" className="rm-navbar fixed top-0 start-0 end-0 z-50 bg-[#060913]/85 backdrop-blur-xl border-b border-slate-800/80 shadow-lg shadow-black/40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 sm:h-20 flex items-center justify-between gap-3">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2.5 hover:opacity-90 transition-all group shrink-0">
            <div className="rm-brand-mark w-9 h-9 sm:w-10 sm:h-10 rounded-lg flex items-center justify-center transition-all">
              <Landmark className="w-[18px] h-[18px] sm:w-5 sm:h-5" strokeWidth={2.2} />
            </div>
            <span className="text-lg sm:text-xl font-bold tracking-tight text-white">
              Remit<span className="text-cyan-400">Mortgage</span>
            </span>
          </Link>

          {/* Desktop Nav Links */}
          <nav role="navigation" className="hidden xl:flex items-center gap-1 text-sm" aria-label="Primary navigation">
            {PRIMARY_LINKS.map(({ href, labelKey }) => {
              const active = pathname === href || pathname.startsWith(`${href}/`);
              return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={`rm-nav-link text-slate-300 font-medium hover:text-cyan-400 transition-colors whitespace-nowrap relative px-3 py-2 group ${active ? "is-active" : ""}`}
              >
                {t(labelKey)}
              </Link>
              );
            })}
            {[
              { label: "Financing", links: FINANCE_LINKS },
              { label: "Operations", links: OPERATIONS_LINKS },
            ].map((group) => {
              const groupActive = group.links.some(({ href }) => pathname === href || pathname.startsWith(`${href}/`));
              return (
                <div className="rm-nav-menu group relative" key={group.label}>
                  <button type="button" className={`rm-nav-menu-trigger ${groupActive ? "is-active" : ""}`} aria-haspopup="true">
                    {group.label}<ChevronDown size={14} />
                  </button>
                  <div className="rm-nav-menu-panel">
                    {group.links.map(({ href, labelKey }) => {
                      const active = pathname === href || pathname.startsWith(`${href}/`);
                      return <Link key={href} href={href} aria-current={active ? "page" : undefined} className={active ? "is-active" : ""}>{t(labelKey)}</Link>;
                    })}
                  </div>
                </div>
              );
            })}
          </nav>

          {/* Desktop Right Actions */}
          <div className="hidden xl:flex items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={openCheatSheet}
              title="Keyboard Shortcuts (?)"
              className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800/80 transition-colors border border-slate-800 bg-slate-900/50 flex items-center gap-1 text-xs"
              aria-label="Open keyboard shortcuts cheat-sheet"
            >
              <Keyboard className="w-4 h-4 text-emerald-400" />
              <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] font-mono bg-slate-800 text-slate-300 rounded border border-slate-700">?</kbd>
            </button>
            <LocaleSwitcher />
            <NotificationButton unreadCount={unreadCount} onClick={togglePanel} />
            <span id="tour-wallet">
              <WalletButton
                isConnected={isConnected}
                publicKey={publicKey}
                usdcBalance={usdcBalance}
                walletType={walletType}
                isConnecting={isConnecting}
                connect={connect}
                disconnect={disconnect}
              />
            </span>
          </div>

          {/* Tablet (lg only) - show condensed: locale, notification, wallet, hamburger */}
          <div className="hidden lg:flex xl:hidden items-center gap-2">
            <LocaleSwitcher />
            <NotificationButton unreadCount={unreadCount} onClick={togglePanel} compact />
            <button aria-label={menuOpen ? "Close menu" : "Open menu"} onClick={() => setMenuOpen((prev) => !prev)} className="rm-menu-button">
              {menuOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
            <WalletButton
              isConnected={isConnected}
              publicKey={publicKey}
              usdcBalance={usdcBalance}
              walletType={walletType}
              isConnecting={isConnecting}
              connect={connect}
              disconnect={disconnect}
              compact
            />
          </div>

          {/* Mobile: notification + hamburger only (wallet/locale inside drawer) */}
          <div className="flex lg:hidden items-center gap-1.5 sm:gap-2">
            <NotificationButton unreadCount={unreadCount} onClick={togglePanel} compact />
            <button
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              aria-controls="mobile-menu"
              onClick={() => setMenuOpen((prev) => !prev)}
              className="p-2 rounded-lg text-slate-200 hover:bg-slate-800/80 transition-colors border border-slate-700/60 bg-slate-900/50"
            >
              {menuOpen ? <X className="w-5 h-5 sm:w-6 sm:h-6" /> : <Menu className="w-5 h-5 sm:w-6 sm:h-6" />}
            </button>
          </div>
        </div>
      </header>

      {/* Overlay */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm xl:hidden"
          aria-hidden="true"
          onClick={() => setMenuOpen(false)}
        />
      )}

      {/* Mobile Slide-Out Drawer */}
      <div
        id="mobile-menu"
        role="dialog"
        aria-modal="true"
        aria-label="Mobile navigation"
        className={`rm-mobile-nav fixed top-0 end-0 z-50 h-full w-[85vw] max-w-sm bg-[#0b0f1d] border-s border-slate-800 flex flex-col xl:hidden transition-transform duration-300 ease-in-out shadow-2xl shadow-black/50 ${
          menuOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Drawer header with quick actions */}
        <div className="pt-20 pb-4 px-6 border-b border-slate-800/60 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Wallet</span>
            <LocaleSwitcher />
          </div>
          <WalletButton
            isConnected={isConnected}
            publicKey={publicKey}
            usdcBalance={usdcBalance}
            walletType={walletType}
            isConnecting={isConnecting}
            connect={connect}
            disconnect={disconnect}
            fullWidth
          />
        </div>

        {/* Nav links */}
        <nav role="navigation" aria-label="Mobile navigation" className="flex-1 overflow-y-auto py-4 px-4">
          {[
            { label: "Borrower", links: PRIMARY_LINKS },
            { label: "Financing", links: FINANCE_LINKS },
            { label: "Operations", links: OPERATIONS_LINKS },
          ].map((group) => <div className="rm-mobile-nav-group" key={group.label}>
            <span>{group.label}</span>
            {group.links.map(({ href, labelKey }) => {
              const active = pathname === href || pathname.startsWith(`${href}/`);
              return (
              <Link
                key={href}
                href={href}
                onClick={() => setMenuOpen(false)}
                aria-current={active ? "page" : undefined}
                className={`rm-mobile-nav-link py-3 px-4 rounded-lg text-slate-200 hover:text-cyan-400 hover:bg-slate-800/60 transition-colors text-sm font-medium flex items-center gap-3 group ${active ? "is-active" : ""}`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-slate-700 group-hover:bg-cyan-400 transition-colors" />
                {t(labelKey)}
              </Link>
              );
            })}
          </div>)}
        </nav>

        {/* Drawer footer */}
        <div className="px-6 py-4 border-t border-slate-800/60">
          <Link
            href="/analytics"
            onClick={() => setMenuOpen(false)}
            className="block text-center py-2.5 rounded-xl text-xs font-semibold text-slate-400 hover:text-cyan-400 hover:bg-slate-800/40 transition-colors"
          >
            Protocol analytics
          </Link>
        </div>
      </div>

      {/* Notice banner stack under the navbar */}
      <div className="fixed top-16 sm:top-20 start-0 end-0 z-40 flex flex-col">
        {wrongNetwork && (
          <div
            role="alert"
            className="bg-amber-500/20 text-amber-300 border-b border-amber-500/30 text-center py-2 text-xs font-semibold backdrop-blur-md"
          >
            ⚠️ {describeNetworkMismatch(network)}
          </div>
        )}

        {showDisconnectNotice && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-center gap-3 border-b border-red-500/30 bg-red-500/15 py-2 text-xs font-semibold text-red-200 backdrop-blur-md"
            style={{ top: noticeOffset }}
          >
            <span>{walletError?.message}</span>
            <button
              type="button"
              onClick={() => connect()}
              className="rounded-md border border-red-400/40 px-2.5 py-1 text-[11px] uppercase tracking-wider text-red-100 transition-colors hover:border-cyan-400/60 hover:text-cyan-200"
            >
              Reconnect
            </button>
            <button
              type="button"
              onClick={clearError}
              aria-label="Dismiss wallet notice"
              className="text-red-300/70 transition-colors hover:text-red-100"
            >
              ✕
            </button>
          </div>
        )}
      </div>
    </>
  );
}

interface WalletButtonProps {
  isConnected: boolean;
  publicKey: string | null;
  usdcBalance: string | null;
  walletType: "stellar" | "evm" | "solana" | "ledger" | null;
  isConnecting: boolean;
  connect: () => Promise<string | null>;
  disconnect: () => void;
  compact?: boolean;
  fullWidth?: boolean;
}

function WalletButton({
  isConnected,
  publicKey,
  usdcBalance,
  walletType,
  isConnecting,
  connect,
  disconnect,
  compact = false,
  fullWidth = false,
}: WalletButtonProps) {
  const t = useTranslations("nav");
  if (!isConnected) {
    return (
      <button
        onClick={() => connect()}
        data-testid="connect-wallet-button"
        disabled={isConnecting}
        className={`btn-cta ${compact ? "!py-2 !px-3 !text-xs" : "!py-2.5 !px-4 !text-xs md:!text-sm"} ${fullWidth ? "!w-full" : ""} shadow-cyan-500/20 disabled:opacity-50`}
      >
        {isConnecting ? "Connecting…" : t("connectWallet")}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M5 12h14" />
          <path d="m12 5 7 7-7 7" />
        </svg>
      </button>
    );
  }
  if (fullWidth) {
    return (
      <div className="space-y-2 w-full">
        <div className="flex items-center justify-between gap-2 w-full">
          <div className="flex items-center gap-2 min-w-0">
            {walletType === "stellar" && (
              <span
                title="Connected via Freighter"
                className="inline-flex items-center gap-1 text-[10px] font-bold text-cyan-400 uppercase tracking-wider px-2 py-1 bg-cyan-500/10 border border-cyan-500/20 rounded-md shrink-0"
              >
                <svg viewBox="0 0 14 14" fill="currentColor" className="w-3 h-3" aria-hidden="true">
                  <circle cx="7" cy="7" r="6" />
                </svg>
                Freighter
              </span>
            )}
            <span
              data-testid="wallet-address-display"
              title={publicKey ?? "Connected"}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700 text-xs font-semibold text-slate-200 font-mono truncate"
            >
              {publicKey ? shorten(publicKey) : "Connected"}
            </span>
          </div>
          <button
            onClick={disconnect}
            data-testid="disconnect-wallet-button"
            className="btn-ghost text-xs hover:text-red-400 shrink-0"
          >
            {t("disconnect")}
          </button>
        </div>
        {usdcBalance != null && (
          <div className="text-xs text-cyan-400 font-semibold px-2.5 py-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/20 w-full text-center">
            {usdcBalance} USDC
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 sm:gap-2">
      {walletType === "stellar" ? (
        <span
          title="Connected via Freighter"
          className={`${compact ? "hidden" : "hidden sm:inline-flex"} items-center gap-1 text-[10px] font-bold text-cyan-400 uppercase tracking-wider px-2 py-1 bg-cyan-500/10 border border-cyan-500/20 rounded-md`}
        >
          <svg viewBox="0 0 14 14" fill="currentColor" className="w-3 h-3" aria-hidden="true">
            <circle cx="7" cy="7" r="6" />
          </svg>
          Freighter
        </span>
      ) : null}

      {!compact && (
        <div className="text-xs md:text-sm text-cyan-400 font-semibold px-2.5 py-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/20 hidden sm:block">
          {usdcBalance != null ? `${usdcBalance} USDC` : "—"}
        </div>
      )}
      <span
        data-testid="wallet-address-display"
        title={publicKey ?? "Connected"}
        className="px-2.5 sm:px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700 text-[11px] sm:text-xs font-semibold text-slate-200 font-mono"
      >
        {publicKey ? shorten(publicKey) : "Conn"}
      </span>
      {!compact && (
        <button
          onClick={disconnect}
          data-testid="disconnect-wallet-button"
          className="btn-ghost text-xs hover:text-red-400"
        >
          {t("disconnect")}
        </button>
      )}
    </div>
  );
}

function NotificationButton({
  unreadCount,
  onClick,
  compact = false,
}: {
  unreadCount: number;
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Open notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ""}`}
      className={`relative inline-flex items-center justify-center rounded-lg border border-slate-700 bg-slate-900/70 text-slate-200 transition-colors hover:border-cyan-400/40 hover:text-cyan-300 hover:bg-slate-800/70 ${
        compact ? "h-9 w-9 sm:h-10 sm:w-10" : "h-10 w-10 sm:h-11 sm:w-11"
      }`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={compact ? "h-4 w-4 sm:h-[18px] sm:w-[18px]" : "h-[18px] w-[18px] sm:h-5 sm:w-5"}
        aria-hidden="true"
      >
        <path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0 1 18 14.172V11a6 6 0 1 0-12 0v3.172a2.032 2.032 0 0 1-.595 1.423L4 17h5" />
        <path d="M9.73 21a2 2 0 0 0 3.54 0" />
      </svg>
      {unreadCount > 0 && (
        <span className="absolute -end-0.5 -top-0.5 inline-flex min-w-[18px] items-center justify-center rounded-full bg-cyan-400 px-1 py-0.5 text-[9px] sm:text-[10px] font-bold leading-none text-slate-950 shadow-lg shadow-cyan-400/30">
          {unreadCount > 9 ? "9+" : unreadCount}
        </span>
      )}
    </button>
  );
}

export default function Navbar() {
  return <InnerNavbar />;
}
