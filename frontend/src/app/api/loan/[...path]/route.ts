import { NextRequest, NextResponse } from "next/server";

const BACKEND_URL = process.env.BACKEND_API_URL || "http://localhost:4000";

async function proxyLoanRequest(request: NextRequest): Promise<NextResponse> {
  const apiPath = request.nextUrl.pathname.replace(/^\/api\/loan/, "");
  const headers = new Headers({ "content-type": "application/json" });
  const cookie = request.headers.get("cookie");
  const csrfToken = request.headers.get("x-csrf-token");
  if (cookie) headers.set("cookie", cookie);
    if (csrfToken) headers.set("x-csrf-token", csrfToken);
  try {
    const response = await fetch(
      `${BACKEND_URL}/api/loan${apiPath}${request.nextUrl.search}`,
      {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer(),
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      }
    );
    const responseHeaders = new Headers();
    const responseContentType = response.headers.get("content-type");
    if (responseContentType) responseHeaders.set("content-type", responseContentType);
    for (const cookieValue of response.headers.getSetCookie()) {
      responseHeaders.append("set-cookie", cookieValue);
    }
    return new NextResponse(response.body, { status: response.status, headers: responseHeaders });
  } catch {
    return NextResponse.json(
      { error: "loan_service_unavailable", message: "Loan application service is unavailable." },
      { status: 502 }
    );
  }
}

export const GET = proxyLoanRequest;
export const POST = proxyLoanRequest;
