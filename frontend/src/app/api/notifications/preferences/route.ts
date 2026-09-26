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
      governanceAlerts: true,
      // No securityFrequency default — security alerts are always immediate
      // and are never represented as a stored/configurable preference.
      depositsFrequency: "IMMEDIATE",
      milestonesFrequency: "IMMEDIATE",
      governanceFrequency: "IMMEDIATE",
      webhookUrl: "",
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Security alerts are never configurable — reject before even reaching
    // the backend, and regardless of whether the backend is reachable, so
    // this can't silently succeed via the offline-dev fallback below.
    if (body?.securityFrequency !== undefined) {
      return NextResponse.json(
        {
          error: "security_frequency_not_configurable",
          message: "Security alerts are always delivered immediately and cannot be changed.",
        },
        { status: 400 }
      );
    }

    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";

    try {
      const res = await fetch(`${backendUrl}/api/notifications/preferences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      // Forward the backend's response as-is (including validation errors)
      // rather than only ever reporting success — a client relying on error
      // feedback (e.g. an invalid frequency value) needs the real status.
      return NextResponse.json(data, { status: res.status });
    } catch {
      // Backend unreachable (offline during dev) — fall back to an
      // in-memory "success" so local development isn't blocked on it.
      return NextResponse.json({ success: true, preferences: body });
    }
  } catch (error) {
    return NextResponse.json({ error: "Failed to update notification preferences" }, { status: 500 });
  }
}
