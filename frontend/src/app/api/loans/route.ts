// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get("limit") || 100), 1), 100);
  return NextResponse.json([
    { name: "Active", value: 70, color: "#6366f1" },
    { name: "Repaid", value: 25, color: "#10b981" },
    { name: "Defaulted", value: 5, color: "#ef4444" },
  ].slice(0, limit));
}
