// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";

type MilestoneEntry = {
  id: string;
  title: string;
  state: string;
  description?: string;
};

type ShareData = {
  id: string;
  borrowerLabel: string;
  deposited: string;
  target: string;
  progress: number;
  apy: string;
  milestonesCompleted: number;
  milestonesTotal: number;
  milestones: MilestoneEntry[];
  loanStatus: string;
};

const MOCK_DATA: Record<string, ShareData> = {
  default: {
    id: "default",
    borrowerLabel: "GCSW...W3RF",
    deposited: "45000",
    target: "100000",
    progress: 45,
    apy: "4.5",
    milestonesCompleted: 2,
    milestonesTotal: 5,
    milestones: [
      { id: "m1", title: "Foundation Inspection", state: "Disbursed", description: "Structural foundation inspection and soil report verification." },
      { id: "m2", title: "Framing Completion", state: "Approved", description: "Wall framing, roof trusses, and window installation verified." },
      { id: "m3", title: "Plumbing & Electrical", state: "Voting", description: "Full plumbing rough-in and electrical wiring inspection." },
      { id: "m4", title: "Final Finishes", state: "Proposed", description: "Interior paint, flooring, fixtures, and final walkthrough." },
      { id: "m5", title: "Occupancy Permit", state: "Proposed", description: "Certificate of occupancy issued by local authority." },
    ],
    loanStatus: "Active",
  },
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const data = MOCK_DATA[id] ?? { ...MOCK_DATA.default, id, borrowerLabel: id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id };
  return NextResponse.json(data);
}
