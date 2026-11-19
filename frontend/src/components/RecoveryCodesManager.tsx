"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useCallback, useEffect, useState } from "react";
import {
  fetchTwoFactorStatus,
  regenerateRecoveryCodes,
  type TwoFactorStatus,
} from "@/lib/twoFactorApi";

/** At or below this many remaining codes the user is warned to regenerate. */
export const LOW_RECOVERY_CODE_THRESHOLD = 3;

/**
 * Two-factor recovery code management (issue #729).
 *
 * Shows how many recovery codes remain (never the codes themselves — they are
 * only ever visible once, right after generation), warns when the count is
 * low, and lets the user regenerate a fresh set. Regeneration invalidates the
 * entire previous set, and the new codes must be copied or downloaded before
 * the dialog can be dismissed.
 */
export default function RecoveryCodesManager() {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [authCode, setAuthCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");

  const load = useCallback(async () => {
    try {
      setStatus(await fetchTwoFactorStatus());
      setLoadError("");
    } catch {
      setLoadError("Couldn't load your two-factor status. Please try again shortly.");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchTwoFactorStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Couldn't load your two-factor status. Please try again shortly.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const remaining = status?.remainingRecoveryCodes ?? 0;
  const isEmpty = status?.enabled && remaining === 0;
  const isLow = status?.enabled && remaining > 0 && remaining <= LOW_RECOVERY_CODE_THRESHOLD;

  async function regenerate() {
    if (!authCode.trim()) {
      setError("Enter a current authenticator code to continue.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const codes = await regenerateRecoveryCodes(authCode.trim());
      setNewCodes(codes);
      setSaved(false);
      setSaveMessage("");
      setConfirming(false);
      setAuthCode("");
      // The previous set is already invalid server-side; reflect that now.
      setStatus((prev) => (prev ? { ...prev, remainingRecoveryCodes: codes.length } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't regenerate recovery codes.");
    } finally {
      setBusy(false);
    }
  }

  async function copyCodes() {
    if (!newCodes) return;
    try {
      await navigator.clipboard.writeText(newCodes.join("\n"));
      setSaved(true);
      setSaveMessage("Recovery codes copied to clipboard.");
    } catch {
      setSaveMessage("Couldn't copy automatically — download the codes instead.");
    }
  }

  function downloadCodes() {
    if (!newCodes) return;
    const blob = new Blob(
      [`RemitMortgage two-factor recovery codes\nEach code can be used once.\n\n${newCodes.join("\n")}\n`],
      { type: "text/plain" }
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "remitmortgage-recovery-codes.txt";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setSaved(true);
    setSaveMessage("Recovery codes downloaded.");
  }

  function dismiss() {
    // Drop the plaintext codes from memory the moment the user is done.
    setNewCodes(null);
    setSaved(false);
    setSaveMessage("");
    void load();
  }

  return (
    <div className="space-y-4" data-testid="recovery-codes-manager">
      <div>
        <h3 className="text-xs font-bold uppercase tracking-wider text-cyan-400">Recovery codes</h3>
        <p className="mt-1 text-sm text-slate-400">
          Use a recovery code to sign in if you lose your authenticator device. Each code works once.
        </p>
      </div>

      {loadError && (
        <p role="alert" className="text-sm text-rose-400">
          {loadError}
        </p>
      )}

      {status && !status.enabled && (
        <p className="text-sm text-slate-400" data-testid="recovery-2fa-disabled">
          Two-factor authentication isn&apos;t enabled, so there are no recovery codes yet.
        </p>
      )}

      {status?.enabled && (
        <>
          <p className="text-sm text-white" data-testid="recovery-remaining">
            <span className="font-mono text-lg font-bold">{remaining}</span> recovery{" "}
            {remaining === 1 ? "code" : "codes"} remaining
          </p>

          {(isLow || isEmpty) && (
            <div
              role="alert"
              data-testid="recovery-low-warning"
              className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
            >
              {isEmpty
                ? "You have no recovery codes left. If you lose your authenticator device you won't be able to sign in. Regenerate your codes now."
                : `Only ${remaining} recovery ${remaining === 1 ? "code is" : "codes are"} left. Regenerate a new set before you run out.`}
            </div>
          )}

          {!confirming && (
            <button
              type="button"
              onClick={() => {
                setConfirming(true);
                setError("");
              }}
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition-colors hover:border-cyan-400"
            >
              Regenerate codes
            </button>
          )}

          {confirming && (
            <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
              <p className="text-sm text-slate-300">
                Regenerating creates a new set and <strong>invalidates all of your existing codes</strong>,
                including any you haven&apos;t used. Confirm with a current authenticator code.
              </p>
              <label className="block text-xs font-semibold text-slate-400" htmlFor="recovery-auth-code">
                Authenticator code
              </label>
              <input
                id="recovery-auth-code"
                value={authCode}
                onChange={(e) => setAuthCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                className="w-40 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-white"
              />
              {error && (
                <p role="alert" className="text-sm text-rose-400">
                  {error}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void regenerate()}
                  disabled={busy}
                  className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-40"
                >
                  {busy ? "Generating…" : "Generate new codes"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(false);
                    setAuthCode("");
                    setError("");
                  }}
                  disabled={busy}
                  className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 disabled:opacity-40"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {newCodes && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="recovery-dialog-title"
            data-testid="recovery-codes-dialog"
            className="w-full max-w-md space-y-4 rounded-2xl border border-slate-700 bg-slate-900 p-6"
          >
            <h4 id="recovery-dialog-title" className="text-lg font-bold text-white">
              Your new recovery codes
            </h4>
            <p className="text-sm text-slate-300">
              Your previous codes no longer work. Save these now — they are shown only once and can&apos;t be
              retrieved later.
            </p>
            <ul className="grid grid-cols-2 gap-2 rounded-xl bg-slate-950 p-4 font-mono text-sm text-cyan-200">
              {newCodes.map((code) => (
                <li key={code} data-testid="recovery-code">
                  {code}
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void copyCodes()}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:border-cyan-400"
              >
                Copy codes
              </button>
              <button
                type="button"
                onClick={downloadCodes}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:border-cyan-400"
              >
                Download codes
              </button>
            </div>
            <p role="status" className="min-h-5 text-xs text-slate-400">
              {saveMessage}
            </p>
            <button
              type="button"
              onClick={dismiss}
              disabled={!saved}
              className="w-full rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-40"
            >
              I&apos;ve saved my codes
            </button>
            {!saved && (
              <p className="text-xs text-slate-500">Copy or download your codes to continue.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
