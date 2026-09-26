// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const envelope = body?.envelope as string | undefined;

    if (!envelope) {
      return NextResponse.json(
        { error: "envelope is required" },
        { status: 400 }
      );
    }

    // Simulate network submission delay
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const txHash = Array.from({ length: 64 })
      .map(() => Math.floor(Math.random() * 16).toString(16))
      .join("");

    console.log(`[mock] Submitted envelope: ${envelope.slice(0, 60)}… → txHash: ${txHash}`);

    return NextResponse.json({ txHash, success: true });
  } catch (error) {
    console.error("Submit error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
