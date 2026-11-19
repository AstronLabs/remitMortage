// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export interface TwoFactorStatus {
  enabled: boolean;
  remainingRecoveryCodes: number;
}

export async function fetchTwoFactorStatus(): Promise<TwoFactorStatus> {
  const res = await fetch(`${API_BASE}/api/admin/2fa/status`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load two-factor status");
  const body = await res.json();
  return {
    enabled: Boolean(body?.enabled),
    remainingRecoveryCodes: Number(body?.remainingRecoveryCodes) || 0,
  };
}

/**
 * Generates a brand-new recovery code set. The server invalidates every
 * previous code in the same step and returns the new plaintext codes exactly
 * once — they can never be fetched again.
 */
export async function regenerateRecoveryCodes(code: string): Promise<string[]> {
  const res = await fetch(`${API_BASE}/api/admin/2fa/recovery-codes/regenerate`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? "Failed to regenerate recovery codes");
  }
  const body = await res.json();
  return Array.isArray(body?.recoveryCodes) ? body.recoveryCodes : [];
}
