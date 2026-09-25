// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { NextRequest, NextResponse } from "next/server";

export type ContractorPayoutRecord = {
  id: string;
  date: string;
  projectRef: string;
  projectName: string;
  milestoneName: string;
  amount: string;
  currency: string;
  status: "Completed" | "Processing" | "Pending Multisig";
  txHash: string;
  escrowContract: string;
  contractorAddress: string;
  taxYear: string;
  notes?: string;
};

const MOCK_CONTRACTOR_PAYOUTS: ContractorPayoutRecord[] = [
  {
    id: "pay-101",
    date: "2026-02-15T14:30:00Z",
    projectRef: "PRJ-MORT-2026-01",
    projectName: "Horizon Heights Residential - Unit 4B",
    milestoneName: "Foundation & Substructure Inspection",
    amount: "12500.00",
    currency: "USDC",
    status: "Completed",
    txHash: "4a7f8e12b39d01f5c6789e0123456789abcdef0123456789abcdef0123456789",
    escrowContract: "CCX4V7R3XKEYKJLMNPQRSTUVWYZ23456789ABCDEF",
    contractorAddress: "GAB123456789CONTRACTORSTELLARPUBLICKEY012345",
    taxYear: "2026",
    notes: "Multisig 3/3 signatures verified on-chain",
  },
  {
    id: "pay-102",
    date: "2026-01-20T10:15:00Z",
    projectRef: "PRJ-MORT-2026-01",
    projectName: "Horizon Heights Residential - Unit 4B",
    milestoneName: "Structural Framing & Steel Beams",
    amount: "15000.00",
    currency: "USDC",
    status: "Completed",
    txHash: "7b8c9d01e23f456789a0123456789abcdef0123456789abcdef0123456789a",
    escrowContract: "CCX4V7R3XKEYKJLMNPQRSTUVWYZ23456789ABCDEF",
    contractorAddress: "GAB123456789CONTRACTORSTELLARPUBLICKEY012345",
    taxYear: "2026",
    notes: "Inspected by Certified Inspector #482",
  },
  {
    id: "pay-103",
    date: "2025-11-28T16:45:00Z",
    projectRef: "PRJ-COMM-2025-09",
    projectName: "Apex Commercial Park Plaza",
    milestoneName: "Roofing Waterproofing & Insulation",
    amount: "9800.00",
    currency: "USDC",
    status: "Completed",
    txHash: "1f2e3d4c5b6a7890123456789abcdef0123456789abcdef0123456789abcdef",
    escrowContract: "CBY987654321ESCROWCONTRACTPUBLICKEY098765432",
    contractorAddress: "GAB123456789CONTRACTORSTELLARPUBLICKEY012345",
    taxYear: "2025",
    notes: "Annual milestone release cycle 1",
  },
  {
    id: "pay-104",
    date: "2025-08-10T11:00:00Z",
    projectRef: "PRJ-COMM-2025-09",
    projectName: "Apex Commercial Park Plaza",
    milestoneName: "Electrical Wiring & HVAC Rough-In",
    amount: "11200.00",
    currency: "USDC",
    status: "Completed",
    txHash: "9a8b7c6d5e4f3210987654321abcdef0123456789abcdef0123456789abcdef",
    escrowContract: "CBY987654321ESCROWCONTRACTPUBLICKEY098765432",
    contractorAddress: "GAB123456789CONTRACTORSTELLARPUBLICKEY012345",
    taxYear: "2025",
  },
];

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const contractorAddress = searchParams.get("contractorAddress");
    const projectRef = searchParams.get("projectRef");
    const taxYear = searchParams.get("taxYear");

    let filtered = [...MOCK_CONTRACTOR_PAYOUTS];

    if (contractorAddress) {
      filtered = filtered.filter(
        (p) => p.contractorAddress.toLowerCase() === contractorAddress.toLowerCase()
      );
    }

    if (projectRef && projectRef !== "All") {
      filtered = filtered.filter((p) => p.projectRef === projectRef);
    }

    if (taxYear && taxYear !== "All") {
      filtered = filtered.filter((p) => p.taxYear === taxYear);
    }

    return NextResponse.json({
      payouts: filtered,
      totalCount: filtered.length,
      totalAmountUSDC: filtered
        .reduce((sum, p) => sum + parseFloat(p.amount), 0)
        .toFixed(2),
    });
  } catch (error) {
    console.error("Contractor payouts API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch contractor payouts" },
      { status: 500 }
    );
  }
}
