"use client";

import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Eye } from "lucide-react";
import { useImpersonation } from "../hooks/useImpersonation";

function shortenAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatCountdown(expiresAt: string | null): string {
  if (!expiresAt) return "--:--";
  const remainingMs = new Date(expiresAt).getTime() - Date.now();
  if (remainingMs <= 0) return "0:00";
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Persistent, non-dismissible banner shown site-wide for the duration of an
 * admin "view as user" session. Unlike WalletBanner, this never offers a
 * close button — the whole point is that it stays visible for as long as the
 * elevated view is active, so nobody mistakes impersonated data for their own.
 */
export default function ImpersonationBanner() {
  const { status, ending, endSession } = useImpersonation();
  const [, forceTick] = useState(0);

  // Re-render every second purely to keep the countdown text current.
  useEffect(() => {
    if (!status.active) return;
    const interval = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, [status.active]);

  if (!status.active) return null;

  async function handleEndSession() {
    try {
      await endSession();
      toast.success("Impersonation session ended.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to end session.");
    }
  }

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[60] bg-gradient-to-r from-rose-700 to-red-700 text-white shadow-xl"
      role="alert"
      aria-live="assertive"
      data-testid="impersonation-banner"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider">
            <Eye className="h-4 w-4 shrink-0" />
            Read-only support view
          </span>
          <span className="text-sm text-rose-100">
            Viewing as{" "}
            <span className="font-mono font-semibold text-white">
              {status.targetAddress ? shortenAddress(status.targetAddress) : "unknown user"}
            </span>{" "}
            — all deposits, withdrawals, and approvals are disabled.
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <span className="text-xs font-mono text-rose-100" title="Time remaining before this session auto-expires">
            Expires in {formatCountdown(status.expiresAt)}
          </span>
          <button
            onClick={handleEndSession}
            disabled={ending}
            data-testid="end-impersonation-button"
            className="rounded-lg bg-white/20 px-3 py-1.5 text-xs font-semibold hover:bg-white/30 transition-colors disabled:opacity-50"
          >
            {ending ? "Ending…" : "End Session"}
          </button>
        </div>
      </div>
    </div>
  );
}
