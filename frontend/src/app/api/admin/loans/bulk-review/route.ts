import { NextRequest, NextResponse } from "next/server";

const backendUrl = process.env.BACKEND_API_URL || "http://localhost:4000";

function forwardedHeaders(request: NextRequest, json = true) {
  const headers = new Headers();
  if (json) headers.set("content-type", "application/json");
  const cookie = request.headers.get("cookie");
  const csrf = request.headers.get("x-csrf-token");
  const auth = request.headers.get("authorization");
  if (cookie) headers.set("cookie", cookie);
  if (csrf) headers.set("x-csrf-token", csrf);
  if (auth) headers.set("authorization", auth);
  return headers;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const response = await fetch(`${backendUrl}/api/admin/loans/bulk-review`, {
      method: "POST",
      headers: forwardedHeaders(request, true),
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: "bulk_review_failed", message: "Loan service is unavailable." },
      { status: 503 }
    );
  }
}
