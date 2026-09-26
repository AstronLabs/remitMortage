// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { NextRequest, NextResponse } from "next/server";
import { createMockProposal } from "@/lib/milestoneSigningStore";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const milestoneId = body?.milestoneId as string | undefined;
    const evidenceCid = body?.evidenceCid as string | undefined;

    if (!milestoneId || !evidenceCid) {
      return NextResponse.json(
        { error: "milestoneId and evidenceCid are required" },
        { status: 400 }
      );
    }

    const proposal = createMockProposal(milestoneId, evidenceCid);
    return NextResponse.json(proposal, { status: 201 });
  } catch (error) {
    console.error("Proposal creation error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
