// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";

// Static fallback used whenever the backend's live contract read is
// unavailable (not configured, RPC down, backend offline in local dev).
// Mirrors the previous hardcoded estimate so the investor page keeps working.
const FALLBACK_RATES = {
  poolApyBps: 620,
  seniorApyBps: 400,
  juniorApyBps: 840,
  seniorLiquidity: "0",
  juniorLiquidity: "0",
  live: false as const,
};

export async function GET() {
  const backendUrl = process.env.BACKEND_API_URL || "http://localhost:4000";

  try {
    const res = await fetch(`${backendUrl}/api/analytics/pool-rates`, {
      // Rates are already cached server-side for 60s; avoid double-caching here.
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return NextResponse.json(FALLBACK_RATES);
    }

    const rates = await res.json();
    return NextResponse.json({ ...rates, live: true });
  } catch {
    // Backend unreachable (offline in local dev, RPC outage, etc.) — degrade
    // gracefully to the static estimate rather than breaking the page.
    return NextResponse.json(FALLBACK_RATES);
  }
}
