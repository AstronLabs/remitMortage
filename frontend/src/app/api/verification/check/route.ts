// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { Horizon } from "@stellar/stellar-sdk";
import {
  computeStats,
  isEligible,
  isValidStellarAddress,
  MatchedPayment,
  MIN_MONTHS,
  MIN_PAYMENTS,
  VerificationResult,
} from "@/lib/verification";

const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL ?? "https://horizon-testnet.stellar.org";

const PAGE_LIMIT = 200;
const MAX_PAGES = 5;

const PAYMENT_TYPES = new Set([
  "payment",
  "path_payment_strict_send",
  "path_payment_strict_receive",
]);

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * Verify a borrower's remittance history.
 *
 * Scans the Horizon payment history of `senderAddress` for payments sent to
 * `recipientAddress`, derives eligibility statistics, and returns a structured
 * result the /verify page renders.
 */
export async function POST(request: Request) {
  let body: { senderAddress?: unknown; recipientAddress?: unknown };
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const { senderAddress, recipientAddress } = body;
  if (!isValidStellarAddress(senderAddress)) {
    return badRequest("Enter a valid sender Stellar address (starts with G).");
  }
  if (!isValidStellarAddress(recipientAddress)) {
    return badRequest("Enter a valid recipient Stellar address (starts with G).");
  }
  if (senderAddress === recipientAddress) {
    return badRequest("Sender and recipient addresses must be different.");
  }

  try {
    const server = new Horizon.Server(HORIZON_URL);
    const matches: MatchedPayment[] = [];

    let page = await server
      .payments()
      .forAccount(senderAddress)
      .order("asc")
      .limit(PAGE_LIMIT)
      .call();

    for (let scanned = 0; scanned < MAX_PAGES; scanned += 1) {
      for (const record of page.records) {
        const op = record as unknown as {
          type: string;
          from?: string;
          to?: string;
          amount?: string;
          created_at: string;
        };
        if (PAYMENT_TYPES.has(op.type) && op.from === senderAddress && op.to === recipientAddress) {
          const amount = Number.parseFloat(op.amount ?? "0");
          matches.push({
            amount: Number.isFinite(amount) ? amount : 0,
            createdAt: op.created_at,
          });
        }
      }

      if (page.records.length < PAGE_LIMIT) break;
      page = await page.next();
    }

    const stats = computeStats(matches);
    const eligible = isEligible(stats);
    const message = eligible
      ? `Eligible: ${stats.totalPayments} payments totaling $${stats.totalVolume.toLocaleString()} over ${stats.timespanMonths} months.`
      : stats.totalPayments === 0
        ? "No remittance payments found from the sender to this recipient."
        : `Not eligible yet: needs at least ${MIN_PAYMENTS} payments over ${MIN_MONTHS} months.`;

    const result: VerificationResult = { eligible, message, stats };
    return NextResponse.json(result);
  } catch (error) {
    const notFound =
      typeof error === "object" &&
      error !== null &&
      "response" in error &&
      (error as { response?: { status?: number } }).response?.status === 404;

    if (notFound) {
      return NextResponse.json(
        { error: "The sender account was not found on this Stellar network." },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: "Could not retrieve payment history. Please try again." },
      { status: 502 }
    );
  }
}
