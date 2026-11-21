"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { Clock } from "lucide-react";
import { useOfferCountdown } from "../hooks/useOfferCountdown";
import { DEFAULT_URGENT_THRESHOLD_MS, isOfferExpired } from "../lib/offerCountdown";

export interface OfferCountdownProps {
  /** Offer validity deadline (ISO string, epoch ms or Date). */
  expiresAt: string | number | Date;
  /** Called when the borrower accepts a still-valid offer. */
  onAccept: () => void;
  urgentThresholdMs?: number;
  acceptLabel?: string;
  /** Disables acceptance for reasons other than expiry (e.g. a request in flight). */
  disabled?: boolean;
}

/**
 * Live countdown for a time-limited loan offer, paired with its accept
 * button. Turns urgent below the threshold and, at the deadline, marks the
 * offer expired and disables acceptance without a reload.
 */
export default function OfferCountdown({
  expiresAt,
  onAccept,
  urgentThresholdMs = DEFAULT_URGENT_THRESHOLD_MS,
  acceptLabel = "Accept offer",
  disabled = false,
}: OfferCountdownProps) {
  const { expired, urgent, label } = useOfferCountdown(expiresAt, urgentThresholdMs);
  const deadline = new Date(expiresAt);

  const handleAccept = () => {
    // Re-check at click time: a stale render must never accept an expired offer.
    if (isOfferExpired(expiresAt)) return;
    onAccept();
  };

  const tone = expired
    ? "border-[var(--text-muted)]/30 bg-[var(--text-muted)]/10 text-[var(--text-muted)]"
    : urgent
      ? "border-red-500/50 bg-red-500/10 text-red-600 animate-pulse"
      : "border-[var(--text-muted)]/30 text-[var(--text-primary)]";

  return (
    <div className="flex flex-wrap items-center justify-between gap-3" data-testid="offer-countdown">
      <div
        className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${tone}`}
        data-state={expired ? "expired" : urgent ? "urgent" : "active"}
        data-testid="offer-countdown-status"
      >
        <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
        {expired ? (
          <span className="font-semibold">Offer expired</span>
        ) : (
          <span>
            Expires in{" "}
            <time
              role="timer"
              aria-live={urgent ? "assertive" : "off"}
              dateTime={deadline.toISOString()}
              className="font-mono font-semibold tabular-nums"
            >
              {label}
            </time>
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={handleAccept}
        disabled={expired || disabled}
        aria-disabled={expired || disabled}
        title={expired ? "This offer has expired and can no longer be accepted." : undefined}
        className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {expired ? "Offer expired" : acceptLabel}
      </button>
    </div>
  );
}
