"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { ShieldCheck, ShieldAlert, Loader2 } from "lucide-react";
import { useWallet } from "../context/WalletContext";
import { useVerificationStatus } from "../hooks/useVerificationStatus";

interface VerificationBadgeProps {
  /** Address to check. Defaults to the connected Stellar wallet. */
  address?: string | null;
  className?: string;
}

/** Format a Unix-seconds expiry as a short human date for the tooltip. */
function formatExpiry(verifiedUntil: number | null): string | undefined {
  if (!verifiedUntil) return undefined;
  return new Date(verifiedUntil * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Live verification badge. Queries the on-chain verification registry via
 * Stellar Horizon as soon as a wallet connects and renders the resulting state.
 * Lookups are cached and de-duplicated by the underlying hook, and an expired
 * record resolves to the unverified state.
 */
export default function VerificationBadge({
  address,
  className = "",
}: VerificationBadgeProps) {
  const { publicKey } = useWallet();
  const resolvedAddress = address ?? publicKey;
  const { status, verifiedUntil } = useVerificationStatus(resolvedAddress);

  // Nothing to show until a wallet is connected.
  if (status === "idle" || !resolvedAddress) return null;

  if (status === "loading") {
    return (
      <span
        role="status"
        aria-live="polite"
        className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-slate-500/10 text-slate-400 border border-slate-500/20 ${className}`}
      >
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Verifying…
      </span>
    );
  }

  if (status === "verified") {
    const expiry = formatExpiry(verifiedUntil);
    return (
      <span
        role="status"
        title={expiry ? `Verification valid until ${expiry}` : undefined}
        className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 ${className}`}
      >
        <ShieldCheck className="w-3.5 h-3.5" />
        Verified
      </span>
    );
  }

  // "unverified" and "error" both surface as an actionable unverified badge.
  const label = status === "error" ? "Verification unavailable" : "Unverified";
  return (
    <span
      role="status"
      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20 ${className}`}
    >
      <ShieldAlert className="w-3.5 h-3.5" />
      {label}
    </span>
  );
}
