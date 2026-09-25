"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * WalletSelectModal
 *
 * Stellar-specific wallet picker that lets users choose between:
 *   1. Freighter browser extension
 *   2. Ledger Nano S / X hardware device
 *
 * After a successful connection the public key is shown and the user can
 * optionally change the BIP-44 derivation path used for Ledger signing.
 *
 * The component is self-contained — it reads and writes the WalletContext
 * directly and only requires `isOpen` / `onClose` props from its parent.
 */

import React, { useState } from "react";
import { X, Wallet, CheckCircle2, AlertCircle, Loader2, ChevronDown, ChevronUp, Copy, ExternalLink } from "lucide-react";
import { useWallet } from "../context/WalletContext";
import { DEFAULT_LEDGER_PATH } from "../lib/ledger";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WalletSelectModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called after a successful connection with the public key. */
  onConnected?: (publicKey: string, walletType: "stellar" | "ledger") => void;
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

/** Pill badge shown on the connected state header. */
function WalletBadge({ type }: { type: "stellar" | "ledger" }) {
  if (type === "ledger") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-bold text-amber-400 uppercase tracking-wider">
        {/* Ledger nano icon approximation */}
        <svg viewBox="0 0 18 18" fill="none" className="w-3.5 h-3.5" aria-hidden="true">
          <rect x="1" y="4" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.8" />
          <rect x="4" y="7" width="4" height="4" rx="0.6" fill="currentColor" />
        </svg>
        Ledger Hardware
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-bold text-cyan-400 uppercase tracking-wider">
      <svg viewBox="0 0 18 18" fill="currentColor" className="w-3.5 h-3.5" aria-hidden="true">
        <path d="M9 1.5a7.5 7.5 0 1 0 0 15A7.5 7.5 0 0 0 9 1.5Zm0 2a5.5 5.5 0 1 1 0 11A5.5 5.5 0 0 1 9 3.5Z" />
        <path d="M9 6a3 3 0 1 0 0 6A3 3 0 0 0 9 6Z" />
      </svg>
      Freighter
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const WalletSelectModal: React.FC<WalletSelectModalProps> = ({
  isOpen,
  onClose,
  onConnected,
}) => {
  const {
    publicKey,
    walletType,
    isConnecting,
    error,
    usdcBalance,
    connect,
    connectLedger,
    disconnect,
    ledgerPath,
    setLedgerPath,
  } = useWallet();

  // Local state ---------------------------------------------------------------
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [pathInput, setPathInput] = useState(ledgerPath);
  const [pathError, setPathError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [connectingType, setConnectingType] = useState<"stellar" | "ledger" | null>(null);
  const [challengeStatus, setChallengeStatus] = useState<string | null>(null);
  const [signatureResult, setSignatureResult] = useState<string | null>(null);

  const wallet = useWallet();

  async function handleSignChallenge() {
    setChallengeStatus("Signing challenge...");
    setSignatureResult(null);
    try {
      const challengeMsg = "auth_challenge_nonce_123456";
      const sig = await wallet.signMessage(challengeMsg);
      if (sig) {
        setSignatureResult(sig);
        setChallengeStatus("Challenge signed successfully!");
      } else {
        setChallengeStatus("Signing failed or returned empty signature.");
      }
    } catch (err: any) {
      setChallengeStatus("Signing error: " + (err?.message || "Unknown error"));
    }
  }

  if (!isOpen) return null;

  const isStellarConnected = walletType === "stellar";

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  async function handleConnectFreighter() {
    setConnectingType("stellar");
    const pk = await connect();
    setConnectingType(null);
    if (pk && onConnected) onConnected(pk, "stellar");
  }

  async function handleConnectLedger() {
    // Validate the BIP-44 path before opening the device picker.
    if (!isValidBip44Path(pathInput)) {
      setPathError("Invalid BIP-44 path. Expected format: 44'/148'/0'");
      return;
    }
    setPathError(null);
    if (pathInput !== ledgerPath) setLedgerPath(pathInput);

    setConnectingType("ledger");
    const pk = await connectLedger();
    setConnectingType(null);
    if (pk && onConnected) onConnected(pk, "ledger");
  }

  function handleDisconnect() {
    disconnect();
    setConnectingType(null);
    setShowAdvanced(false);
  }

  async function handleCopy() {
    if (!publicKey) return;
    try {
      await navigator.clipboard.writeText(publicKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard may be unavailable in some contexts */
    }
  }

  function handlePathChange(e: React.ChangeEvent<HTMLInputElement>) {
    setPathInput(e.target.value);
    if (pathError) setPathError(null);
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  function renderConnectedState() {
    const type = walletType as "stellar" | "ledger";
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 relative overflow-hidden shadow-inner">
        {/* Top accent bar */}
        <div className="absolute top-0 left-0 w-full h-[3px] bg-gradient-to-r from-cyan-500 to-emerald-500" />

        <div className="flex items-start justify-between mb-4">
          <div>
            <WalletBadge type={type} />
            <p className="mt-2 text-zinc-100 font-semibold text-sm">Connected</p>
          </div>
          <button
            onClick={handleDisconnect}
            data-testid="disconnect-wallet-btn"
            className="text-xs text-zinc-500 hover:text-red-400 transition-colors underline underline-offset-2 mt-1"
          >
            Disconnect
          </button>
        </div>

        {/* Public key row */}
        <div className="flex items-center gap-2 bg-zinc-950 rounded-lg px-3 py-2.5 border border-zinc-800 mb-4">
          <span
            data-testid="connected-public-key"
            className="text-zinc-300 font-mono text-xs flex-1 truncate"
            title={publicKey ?? ""}
          >
            {publicKey}
          </span>
          <button
            onClick={handleCopy}
            aria-label="Copy public key"
            className="text-zinc-500 hover:text-cyan-400 transition-colors shrink-0"
          >
            {copied ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
          <a
            href={`https://stellar.expert/explorer/testnet/account/${publicKey}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View on Stellar Expert"
            className="text-zinc-500 hover:text-cyan-400 transition-colors shrink-0"
          >
            <ExternalLink className="w-4 h-4" />
          </a>
        </div>

        {/* Balance pill */}
        <div className="flex items-center justify-between text-sm mb-3">
          <span className="text-zinc-500 text-xs font-medium">USDC Balance</span>
          <span className="text-cyan-400 font-semibold text-xs px-2.5 py-1 bg-cyan-500/10 border border-cyan-500/20 rounded-full">
            {usdcBalance != null ? `${usdcBalance} USDC` : "—"}
          </span>
        </div>

        {/* Challenge Signing Section */}
        <div className="mt-4 pt-4 border-t border-zinc-800/80 space-y-2">
          <button
            onClick={handleSignChallenge}
            data-testid="sign-challenge-btn"
            className="w-full py-2 px-3 bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-xs rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            Sign Auth Challenge
          </button>
          {challengeStatus && (
            <p className="text-[11px] text-zinc-400 text-center">{challengeStatus}</p>
          )}
          {signatureResult && (
            <div
              data-testid="signed-challenge-result"
              className="p-2.5 bg-zinc-950 border border-emerald-500/30 rounded-lg text-emerald-400 text-[11px] font-mono break-all"
            >
              Signature: {signatureResult}
            </div>
          )}
        </div>

        {/* Ledger path info */}
        {type === "ledger" && (
          <p className="mt-3 text-zinc-600 text-xs font-mono">
            Path: {ledgerPath}
          </p>
        )}
      </div>
    );
  }

  function renderOptionButtons() {
    return (
      <div className="space-y-3">
        {/* ── Freighter ── */}
        <button
          onClick={handleConnectFreighter}
          data-testid="connect-freighter-btn"
          disabled={isConnecting}
          aria-label="Connect with Freighter"
          className="w-full flex items-center justify-between p-4 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-cyan-500/50 rounded-xl transition-all group disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-500"
        >
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-full bg-cyan-500/10 flex items-center justify-center group-hover:scale-110 transition-transform shrink-0">
              {/* Stellar/Freighter icon */}
              <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5" aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="#22d3ee" strokeWidth="1.8" />
                <circle cx="12" cy="12" r="4" fill="#22d3ee" />
              </svg>
            </div>
            <div className="text-left">
              <span className="block font-bold text-zinc-100 text-sm">Freighter</span>
              <span className="block text-xs text-zinc-500 mt-0.5">Stellar browser extension</span>
            </div>
          </div>
          {connectingType === "stellar" ? (
            <Loader2 className="w-5 h-5 text-cyan-400 animate-spin shrink-0" />
          ) : (
            <svg viewBox="0 0 20 20" fill="none" className="w-5 h-5 text-zinc-600 group-hover:text-cyan-400 transition-colors shrink-0" aria-hidden="true">
              <path d="M7 10h6M10 7l3 3-3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>

        {/* ── Ledger ── */}
        <div className="border border-zinc-800 hover:border-amber-500/50 rounded-xl transition-all overflow-hidden group">
          <button
            onClick={handleConnectLedger}
            disabled={isConnecting}
            aria-label="Connect with Ledger"
            className="w-full flex items-center justify-between p-4 bg-zinc-900 hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500"
          >
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center group-hover:scale-110 transition-transform shrink-0">
                {/* Ledger device icon */}
                <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5" aria-hidden="true">
                  <rect x="2" y="6" width="20" height="12" rx="2.5" stroke="#f59e0b" strokeWidth="1.8" />
                  <rect x="5" y="9" width="5" height="6" rx="1" fill="#f59e0b" />
                  <circle cx="16" cy="12" r="1.5" fill="#f59e0b" />
                </svg>
              </div>
              <div className="text-left">
                <span className="block font-bold text-zinc-100 text-sm">Ledger Nano S / X</span>
                <span className="block text-xs text-zinc-500 mt-0.5">Hardware security key</span>
              </div>
            </div>
            {connectingType === "ledger" ? (
              <Loader2 className="w-5 h-5 text-amber-400 animate-spin shrink-0" />
            ) : (
              <svg viewBox="0 0 20 20" fill="none" className="w-5 h-5 text-zinc-600 group-hover:text-amber-400 transition-colors shrink-0" aria-hidden="true">
                <path d="M7 10h6M10 7l3 3-3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>

          {/* Advanced / BIP-44 path accordion */}
          <div className="border-t border-zinc-800/60">
            <button
              onClick={() => setShowAdvanced((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors bg-zinc-900/50"
              aria-expanded={showAdvanced}
            >
              <span>Advanced: derivation path</span>
              {showAdvanced ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
            </button>

            {showAdvanced && (
              <div className="px-4 pb-4 bg-zinc-900/50 space-y-2">
                <label
                  htmlFor="ledger-path"
                  className="block text-xs text-zinc-400 font-medium"
                >
                  BIP-44 path
                  <span className="ml-1 text-zinc-600 font-normal">
                    (default: {DEFAULT_LEDGER_PATH})
                  </span>
                </label>
                <input
                  id="ledger-path"
                  type="text"
                  value={pathInput}
                  onChange={handlePathChange}
                  placeholder={DEFAULT_LEDGER_PATH}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  className="w-full bg-zinc-950 border border-zinc-700 focus:border-amber-500 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 placeholder-zinc-600 outline-none transition-colors"
                />
                {pathError && (
                  <p className="text-xs text-red-400 flex items-center gap-1">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    {pathError}
                  </p>
                )}
                <p className="text-xs text-zinc-600 leading-relaxed">
                  Change the account index (last number) to access additional
                  Stellar accounts on the same device.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* WebHID / WebUSB notice for unsupported browsers */}
        <p className="text-xs text-zinc-600 text-center leading-relaxed pt-1">
          Ledger requires a Chromium-based browser with WebHID or WebUSB support.
        </p>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wallet-select-title"
    >
      {/* Backdrop click closes */}
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />

      <div className="relative w-full max-w-md bg-zinc-950 border border-zinc-800 shadow-2xl rounded-2xl overflow-hidden flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800/80 bg-zinc-900/50">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-cyan-500/10 rounded-lg">
              <Wallet className="w-5 h-5 text-cyan-400" aria-hidden="true" />
            </div>
            <h2
              id="wallet-select-title"
              className="text-base font-bold text-zinc-100 tracking-tight"
            >
              Connect Stellar Wallet
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close wallet dialog"
            className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-500"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">

          {/* Global error banner */}
          {error && (
            <div className="flex items-start gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400">
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-sm leading-snug">{error}</p>
            </div>
          )}

          {/* Connecting overlay */}
          {isConnecting && (
            <div className="flex items-center justify-center gap-3 py-3 bg-zinc-900 rounded-xl border border-zinc-800">
              <Loader2 className="w-5 h-5 text-cyan-400 animate-spin" aria-hidden="true" />
              <span className="text-sm text-zinc-300 font-medium">
                {connectingType === "ledger"
                  ? "Waiting for Ledger device…"
                  : "Connecting to Freighter…"}
              </span>
            </div>
          )}

          {/* Ledger-specific instructions shown while connecting */}
          {isConnecting && connectingType === "ledger" && (
            <ol className="text-xs text-zinc-500 space-y-1.5 pl-1 list-decimal list-inside leading-relaxed">
              <li>Plug in your Ledger and unlock it.</li>
              <li>Open the <span className="text-zinc-400 font-medium">Stellar</span> app on the device.</li>
              <li>Select your device in the browser popup and click <span className="text-zinc-400 font-medium">Connect</span>.</li>
            </ol>
          )}

          {/* Main content: connected state or option buttons */}
          {!isConnecting && (
            isStellarConnected ? renderConnectedState() : renderOptionButtons()
          )}
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Very lightweight BIP-44 path validator for the Stellar coin type (148). */
function isValidBip44Path(path: string): boolean {
  // Accepts: 44'/148'/N'  where N is a non-negative integer.
  return /^44'\/148'\/\d+'$/.test(path.trim());
}
