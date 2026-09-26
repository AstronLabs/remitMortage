"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { useNarration } from "@/context/NarrationContext";

/**
 * Opt-in toggle and playback controls for spoken loan terms.
 *
 * Renders the opt-in switch at all times, and the transport controls only
 * once narration is switched on, so the resting state stays visually quiet.
 */
export default function LoanTermsNarrationControls({ className = "" }: { className?: string }) {
  const {
    supported,
    enabled,
    setEnabled,
    play,
    pause,
    resume,
    replay,
    restart,
    stop,
    rate,
    cycleRate,
    status,
    index,
    total,
  } = useNarration();

  const speaking = status === "speaking";
  const paused = status === "paused";
  const inProgress = speaking || paused;

  const togglePlayback = () => {
    if (speaking) {
      pause();
      return;
    }
    if (paused) {
      // Resume continues from the paused term rather than restarting it.
      resume();
      return;
    }
    play();
  };

  const playLabel = speaking ? "Pause" : paused ? "Resume" : "Play";

  return (
    <section
      aria-label="Spoken loan terms"
      data-testid="loan-terms-narration"
      className={`rounded-xl border border-slate-800 bg-slate-950/40 p-4 text-slate-300 ${className}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-white">Read loan terms aloud</h3>
          <p className="mt-1 text-xs text-slate-400">
            Narrates the principal, rate, term length and penalties on this page.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setEnabled(!enabled)}
          aria-pressed={enabled}
          disabled={!supported}
          data-testid="narration-toggle"
          className={`rounded-lg border px-3 py-2 text-xs font-bold transition-all ${
            enabled
              ? "border-cyan-500 bg-cyan-500/10 text-white"
              : "border-slate-800 bg-slate-950/40 text-slate-400 hover:border-slate-700"
          } disabled:cursor-not-allowed disabled:opacity-50`}
        >
          {enabled ? "ACTIVE" : "OFF"}
          <span className="sr-only">
            {enabled ? "Spoken loan terms are on" : "Spoken loan terms are off"}
          </span>
        </button>
      </div>

      {!supported && (
        <p className="mt-3 text-xs text-amber-400" data-testid="narration-unsupported">
          Speech narration is not available in this browser.
        </p>
      )}

      {enabled && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-800 pt-4">
          <button
            type="button"
            onClick={togglePlayback}
            data-testid="narration-playback"
            aria-label={playLabel}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:border-cyan-500"
          >
            {playLabel}
          </button>

          <button
            type="button"
            onClick={replay}
            disabled={!inProgress}
            data-testid="narration-replay"
            aria-label="Replay current term"
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:border-cyan-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Replay term
          </button>

          <button
            type="button"
            onClick={restart}
            disabled={!inProgress}
            data-testid="narration-restart"
            aria-label="Restart from the first term"
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:border-cyan-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Start over
          </button>

          <button
            type="button"
            onClick={stop}
            disabled={status === "idle"}
            data-testid="narration-stop"
            aria-label="Stop narration"
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:border-cyan-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Stop
          </button>

          <button
            type="button"
            onClick={cycleRate}
            data-testid="narration-rate"
            aria-label={`Playback speed ${rate} times`}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:border-cyan-500"
          >
            Speed {rate}x
          </button>

          <span className="ml-auto text-xs text-slate-400" data-testid="narration-progress">
            {total > 0 ? `Term ${Math.min(index + 1, total)} of ${total}` : "No terms found"}
          </span>
        </div>
      )}

      {/*
        Mirrors playback state into the accessibility tree so a screen-reader
        user hears the same progress the speech engine is announcing. Visual
        state changes alone would be invisible to them.
      */}
      <p aria-live="polite" className="sr-only" data-testid="narration-status">
        {enabled ? narrationStatusMessage(status, index, total) : ""}
      </p>
    </section>
  );
}

function narrationStatusMessage(status: string, index: number, total: number): string {
  if (status === "idle") return "Narration stopped.";
  if (status === "done") return "Finished reading all loan terms.";
  const position = total > 0 ? `Term ${Math.min(index + 1, total)} of ${total}.` : "";
  if (status === "paused") return `${position} Paused.`;
  return `${position} Reading.`;
}
