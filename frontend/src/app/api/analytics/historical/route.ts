// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";

export async function GET() {
  // Generate mock historical data for the past 6 months
  const data = [];
  const now = new Date();
  
  let currentTVL = 250000;
  let currentAPY = 4.2;
  
  for (let i = 6; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    
    // Add some random noise and general upward trend
    currentTVL += Math.random() * 50000 + 20000;
    currentAPY = Math.max(3.5, Math.min(8.5, currentAPY + (Math.random() * 0.8 - 0.3)));
    
    data.push({
      date: date.toISOString().slice(0, 7), // YYYY-MM
      tvl: Math.round(currentTVL),
      apy: Number(currentAPY.toFixed(2))
    });
  }

  // Simulate network delay
  await new Promise(resolve => setTimeout(resolve, 800));

  return NextResponse.json(data);
}
