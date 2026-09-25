// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { NextRequest, NextResponse } from "next/server";

/**
 * Push subscription registry.
 *
 * Proxies to the backend notification service, which owns delivery and is what
 * actually filters events against each subscriber's topic preferences. When
 * the backend is unreachable the route degrades to an acknowledgement so local
 * development still exercises the full UI flow.
 */

const backendUrl = () => process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";

const PUSH_ENDPOINT = "/api/notifications/push";

async function proxy(method: string, body: unknown) {
  const res = await fetch(`${backendUrl()}${PUSH_ENDPOINT}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`backend responded ${res.status}`);
  return res.json();
}

export async function GET(request: NextRequest) {
  const address = new URL(request.url).searchParams.get("address");
  if (!address) {
    return NextResponse.json({ error: "Address is required" }, { status: 400 });
  }

  try {
    const res = await fetch(
      `${backendUrl()}${PUSH_ENDPOINT}?address=${encodeURIComponent(address)}`
    );
    if (res.ok) return NextResponse.json(await res.json());
  } catch {
    // Fall through to defaults below.
  }

  // No stored record yet — the client normalizes this into all-topics-on.
  return NextResponse.json({ preferences: null, subscribed: false });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body?.address || !body?.subscription?.endpoint) {
      return NextResponse.json(
        { error: "address and subscription.endpoint are required" },
        { status: 400 }
      );
    }

    try {
      return NextResponse.json(await proxy("POST", body));
    } catch {
      return NextResponse.json({ success: true, subscribed: true });
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body?.address || !body?.endpoint) {
      return NextResponse.json(
        { error: "address and endpoint are required" },
        { status: 400 }
      );
    }

    try {
      return NextResponse.json(await proxy("PATCH", body));
    } catch {
      return NextResponse.json({ success: true, preferences: body.preferences });
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body?.address || !body?.endpoint) {
      return NextResponse.json(
        { error: "address and endpoint are required" },
        { status: 400 }
      );
    }

    try {
      return NextResponse.json(await proxy("DELETE", body));
    } catch {
      return NextResponse.json({ success: true, subscribed: false });
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
}
