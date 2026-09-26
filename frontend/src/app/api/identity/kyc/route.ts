// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { NextRequest, NextResponse } from "next/server";

const backendUrl = process.env.BACKEND_API_URL || "http://localhost:4000";

export async function POST(request: NextRequest) {
  const address = request.nextUrl.searchParams.get("address");
  if (!address) return NextResponse.json({ error: "address is required" }, { status: 400 });
  try {
    const response = await fetch(`${backendUrl}/api/kyc/${encodeURIComponent(address)}/upload`, {
      method: "POST",
      headers: {
        cookie: request.headers.get("cookie") || "",
        "x-csrf-token": request.headers.get("x-csrf-token") || "",
      },
      body: await request.formData(),
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch {
    return NextResponse.json({ error: "KYC service is unavailable." }, { status: 503 });
  }
}
