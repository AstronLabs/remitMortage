// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Client for the backend application save point (issue #1110). Progress is
 * stored against the signed-in wallet, so it follows the applicant to any
 * device. Requests go through the `/api/loan` proxy, which forwards the
 * session cookie.
 */

const PROGRESS_URL = "/api/loan/progress";

export interface SavedApplicationProgress {
  step: number;
  totalSteps: number;
  data: Record<string, unknown>;
  updatedAt: string;
}

export type LoadProgressResult =
  | { status: "found"; progress: SavedApplicationProgress }
  | { status: "none" }
  | { status: "unauthenticated" }
  | { status: "error" };

function csrfHeaders(): Record<string, string> {
  if (typeof document === "undefined") return {};
  const csrf = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("csrfToken="))
    ?.slice("csrfToken=".length);
  return csrf ? { "x-csrf-token": decodeURIComponent(csrf) } : {};
}

export async function loadApplicationProgress(): Promise<LoadProgressResult> {
  try {
    const response = await fetch(PROGRESS_URL, { credentials: "include", cache: "no-store" });
    if (response.status === 404) return { status: "none" };
    if (response.status === 401) return { status: "unauthenticated" };
    if (!response.ok) return { status: "error" };
    return { status: "found", progress: (await response.json()) as SavedApplicationProgress };
  } catch {
    return { status: "error" };
  }
}

/** Returns true when the backend accepted the save. Never throws. */
export async function saveApplicationProgress(
  progress: Omit<SavedApplicationProgress, "updatedAt">
): Promise<boolean> {
  try {
    const response = await fetch(PROGRESS_URL, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...csrfHeaders() },
      body: JSON.stringify(progress),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function clearApplicationProgress(): Promise<void> {
  try {
    await fetch(PROGRESS_URL, {
      method: "DELETE",
      credentials: "include",
      headers: csrfHeaders(),
    });
  } catch {
    // Best effort: a stale save point is harmless and is replaced on next save.
  }
}

/** Whole-number percentage of steps completed before `step`. */
export function progressPercent(step: number, totalSteps: number): number {
  if (totalSteps <= 0) return 0;
  const completed = Math.min(Math.max(step - 1, 0), totalSteps);
  return Math.round((completed / totalSteps) * 100);
}
