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
    const { applicationIds, assigneeAddress, reviewerId, reason } = body;

    if (!Array.isArray(applicationIds) || applicationIds.length === 0) {
      return NextResponse.json(
        { error: "invalid_request", message: "applicationIds array is required" },
        { status: 400 }
      );
    }

    const targetReviewer = assigneeAddress || reviewerId;
    if (!targetReviewer) {
      return NextResponse.json(
        { error: "invalid_request", message: "assigneeAddress or reviewerId is required" },
        { status: 400 }
      );
    }

    const results: Array<{ applicationId: string; status: string }> = [];
    const failures: Array<{ applicationId: string; error: string }> = [];

    // Process each application independently so a failure on one doesn't block others
    await Promise.all(
      applicationIds.map(async (id: string) => {
        try {
          const res = await fetch(`${backendUrl}/api/loan/${id}/review`, {
            method: "POST",
            headers: forwardedHeaders(request, true),
            body: JSON.stringify({
              reviewerId: targetReviewer,
              decision: "APPROVED",
              reason: reason || `Reassigned to reviewer ${targetReviewer}`,
            }),
          });
          if (res.ok) {
            results.push({ applicationId: id, status: "Reassigned" });
          } else {
            const errData = await res.json().catch(() => ({}));
            failures.push({
              applicationId: id,
              error: errData.message || errData.error || `HTTP ${res.status}`,
            });
          }
        } catch (err: any) {
          failures.push({
            applicationId: id,
            error: err.message || "Reassignment request failed",
          });
        }
      })
    );

    return NextResponse.json({
      processed: results.length,
      failed: failures.length,
      results,
      failures,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "reassign_failed", message: "Reassignment service failed" },
      { status: 500 }
    );
  }
}
