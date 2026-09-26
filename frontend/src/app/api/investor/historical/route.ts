// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get("wallet");
  
  if (!wallet) {
    return NextResponse.json({ error: "Wallet parameter is required" }, { status: 400 });
  }

  // Generate mock historical yield data for the specific investor over the last 12 months
  const data = [];
  const now = new Date();
  
  let currentYield = 0;
  
  // Create 12 months of historical data
  for (let i = 11; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    
    // Simulate compounding yield (starts small, grows slightly faster over time)
    // We'll use a random base increase, simulating realistic monthly payouts
    const monthlyAccrual = Math.random() * 5 + 2; 
    currentYield += monthlyAccrual;
    
    data.push({
      date: date.toISOString().slice(0, 7), // YYYY-MM
      yieldUsdc: Number(currentYield.toFixed(2)),
    });
  }

  // Simulate network delay
  await new Promise(resolve => setTimeout(resolve, 600));

  return NextResponse.json(data);
}
