import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json([
    { name: "Active", value: 70, color: "#6366f1" },
    { name: "Repaid", value: 25, color: "#10b981" },
    { name: "Defaulted", value: 5, color: "#ef4444" }
  ]);
}
