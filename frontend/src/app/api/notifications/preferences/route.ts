// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address") || searchParams.get("userId");

  if (!address) {
    return NextResponse.json({ error: "Address is required" }, { status: 400 });
  }

  try {
    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";
    const res = await fetch(`${backendUrl}/api/notifications/preferences?address=${encodeURIComponent(address)}`);
    
    if (res.ok) {
      const data = await res.json();
      return NextResponse.json(data);
    }
  } catch {
    // Fallback to default in-memory response if backend server is offline during dev
  }

  return NextResponse.json({
    preferences: {
      emailAlerts: true,
      smsAlerts: false,
      escrowApproaching: true,
      escrowReached: true,
      paymentMissed: true,
      loanMilestones: true,
      webhookUrl: "",
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";

    try {
      const res = await fetch(`${backendUrl}/api/notifications/preferences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const data = await res.json();
        return NextResponse.json(data);
      }
    } catch {
      // Best-effort backend proxy
    }

    return NextResponse.json({ success: true, preferences: body });
  } catch (error) {
    return NextResponse.json({ error: "Failed to update notification preferences" }, { status: 500 });
  }
}
