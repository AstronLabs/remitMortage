// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { NextRequest, NextResponse } from "next/server";
import { castVote } from "@/lib/milestoneSigningStore";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await _request.json().catch(() => null);
    const signerAddress = body?.signerAddress as string | undefined;

    if (!signerAddress) {
      return NextResponse.json(
        { error: "signerAddress is required" },
        { status: 400 }
      );
    }

    const updated = castVote(id, signerAddress);
    if (!updated) {
      return NextResponse.json(
        { error: "Invalid proposal ID, signer not found, or proposal already closed" },
        { status: 400 }
      );
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Vote error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
