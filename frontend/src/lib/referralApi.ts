const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type ReferralCodeResponse = {
  code: string;
  ownerAddress: string;
  inviteLink: string;
  createdAt: string;
};

export type ReferralStatsResponse = {
  code: string | null;
  inviteLink: string | null;
  invitesSent: number;
  conversions: number;
  recentAttributions: Array<{ referredAddress: string; createdAt: string }>;
};

export async function fetchReferralCode(ownerAddress: string): Promise<ReferralCodeResponse> {
  const res = await fetch(
    `${API_BASE}/api/referral/code?ownerAddress=${encodeURIComponent(ownerAddress)}`
  );
  if (!res.ok) {
    throw new Error("Failed to load referral code");
  }
  return res.json();
}

export async function fetchReferralStats(ownerAddress: string): Promise<ReferralStatsResponse> {
  const res = await fetch(
    `${API_BASE}/api/referral/stats?ownerAddress=${encodeURIComponent(ownerAddress)}`
  );
  if (!res.ok) {
    throw new Error("Failed to load referral stats");
  }
  return res.json();
}

export async function attributeReferralCode(code: string, referredAddress: string) {
  const res = await fetch(`${API_BASE}/api/referral/attribute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, referredAddress }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Failed to attribute referral");
  }
  return res.json();
}

export const REFERRAL_QUERY_PARAM = "ref";
export const REFERRAL_STORAGE_KEY = "rm-referral-code";

export function persistReferralCode(code: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(REFERRAL_STORAGE_KEY, code);
}

export function readPersistedReferralCode(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(REFERRAL_STORAGE_KEY);
}
