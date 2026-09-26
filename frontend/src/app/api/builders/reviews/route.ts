// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import {
  addReview,
  hasReviewed,
  listReviews,
} from "@/lib/builderReviewStore";
import { validateReview } from "@/lib/builderReputation";

export async function GET(request: Request) {
  const builderId = new URL(request.url).searchParams.get("builderId") ?? undefined;
  return NextResponse.json(listReviews(builderId));
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const draft = {
    builderId: String(body.builderId ?? ""),
    reviewer: String(body.reviewer ?? ""),
    rating: Number(body.rating ?? 0),
    comment: String(body.comment ?? "").trim(),
  };

  // Borrower authentication is proven by a connected wallet address.
  if (!draft.reviewer) {
    return NextResponse.json(
      { error: "Authentication required: connect a borrower wallet." },
      { status: 401 }
    );
  }

  const error = validateReview(draft);
  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }

  if (hasReviewed(draft.builderId, draft.reviewer)) {
    return NextResponse.json(
      { error: "You have already reviewed this builder." },
      { status: 409 }
    );
  }

  return NextResponse.json(addReview(draft), { status: 201 });
}
