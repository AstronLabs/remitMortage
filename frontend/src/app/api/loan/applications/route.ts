// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { NextRequest, NextResponse } from "next/server";

const backendUrl = process.env.BACKEND_API_URL || "http://localhost:4000";

function forwardedHeaders(request: NextRequest, json = false) {
  const headers = new Headers();
  if (json) headers.set("content-type", "application/json");
  const cookie = request.headers.get("cookie");
  const csrf = request.headers.get("x-csrf-token");
  if (cookie) headers.set("cookie", cookie);
  if (csrf) headers.set("x-csrf-token", csrf);
  return headers;
}

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get("address");
  if (!address) return NextResponse.json({ error: "address is required" }, { status: 400 });
  try {
    const response = await fetch(`${backendUrl}/api/loan/borrower/${encodeURIComponent(address)}`, {
      headers: forwardedHeaders(request), cache: "no-store",
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch {
    return NextResponse.json({ error: "Loan service is unavailable." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const response = await fetch(`${backendUrl}/api/loan/apply`, {
      method: "POST", headers: forwardedHeaders(request, true), body: JSON.stringify(body),
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch {
    return NextResponse.json({ error: "Loan service is unavailable." }, { status: 503 });
  }
}
