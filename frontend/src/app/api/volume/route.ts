import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const monthsParam = searchParams.get("months");
  const targetMonths = monthsParam ? parseInt(monthsParam, 10) : 12;

  const data = [
    { month: "Jul 25", deposits: 40000, repayments: 10000, disbursements: 20000 },
    { month: "Aug 25", deposits: 45000, repayments: 12000, disbursements: 25000 },
    { month: "Sep 25", deposits: 42000, repayments: 14000, disbursements: 22000 },
    { month: "Oct 25", deposits: 52000, repayments: 16000, disbursements: 30000 },
    { month: "Nov 25", deposits: 58000, repayments: 18000, disbursements: 35000 },
    { month: "Dec 25", deposits: 65000, repayments: 22000, disbursements: 40000 },
    { month: "Jan 26", deposits: 70000, repayments: 25000, disbursements: 45000 },
    { month: "Feb 26", deposits: 72000, repayments: 28000, disbursements: 48000 },
    { month: "Mar 26", deposits: 85000, repayments: 32000, disbursements: 55000 },
    { month: "Apr 26", deposits: 90000, repayments: 35000, disbursements: 60000 },
    { month: "May 26", deposits: 105000, repayments: 40000, disbursements: 70000 },
    { month: "Jun 26", deposits: 120000, repayments: 45000, disbursements: 80000 }
  ];

  return NextResponse.json(data.slice(-targetMonths));
}
