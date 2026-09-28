const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const CSRF_COOKIE = "csrfToken";
const CSRF_HEADER = "x-csrf-token";

export interface ImpersonationStatus {
  active: boolean;
  sessionId: string | null;
  adminAddress: string | null;
  targetAddress: string | null;
  startedAt: string | null;
  expiresAt: string | null;
}

/** Reads the non-HttpOnly double-submit CSRF cookie the backend issues to every client. */
function readCsrfCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export async function fetchImpersonationStatus(): Promise<ImpersonationStatus> {
  const res = await fetch(`${API_BASE}/api/admin/impersonate/status`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error("Failed to fetch impersonation status");
  }
  return res.json();
}

export async function startImpersonation(
  targetWallet: string,
  reason?: string
): Promise<{ sessionId: string; targetWallet: string; expiresAt: string }> {
  const res = await fetch(`${API_BASE}/api/admin/impersonate/start`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      [CSRF_HEADER]: readCsrfCookie() ?? "",
    },
    body: JSON.stringify({ targetWallet, reason }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || "Failed to start impersonation session");
  }

  return res.json();
}

export async function endImpersonation(sessionId?: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/admin/impersonate/end`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      [CSRF_HEADER]: readCsrfCookie() ?? "",
    },
    body: JSON.stringify(sessionId ? { sessionId } : {}),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || "Failed to end impersonation session");
  }
}
