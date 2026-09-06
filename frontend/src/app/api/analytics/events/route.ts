import { NextRequest, NextResponse } from "next/server";

const backendUrl = process.env.BACKEND_API_URL || "http://localhost:4000";

export async function POST(request: NextRequest) {
  try {
    const response = await fetch(`${backendUrl}/api/analytics/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(request.headers.get("cookie") ? { cookie: request.headers.get("cookie")! } : {}),
        ...(request.headers.get("authorization") ? { authorization: request.headers.get("authorization")! } : {}),
        ...(request.headers.get("x-csrf-token") ? { "x-csrf-token": request.headers.get("x-csrf-token")! } : {}),
      },
      body: JSON.stringify(await request.json()),
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch {
    return NextResponse.json({ error: "analytics_unavailable" }, { status: 503 });
  }
}