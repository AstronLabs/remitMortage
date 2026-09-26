// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import LoanStatusCard from "../LoanStatusCard";
import { collectNarrationSegments } from "@/lib/loanTermsNarration";

function narratable(): string[] {
  return collectNarrationSegments(screen.getByTestId("loan-status-card")).map(
    (segment) => segment.text
  );
}

describe("LoanStatusCard narration markup", () => {
  it("marks up every critical loan term for narration", () => {
    render(
      <LoanStatusCard
        loan={{
          status: "Active",
          principal: "25000",
          disbursed: "10000",
          repaid: "2000",
          interestRateBps: 650,
          termMonths: 30,
          lateFeeBps: 250,
        }}
      />
    );

    const spoken = narratable();

    // fix.md asks for principal, rate, term length and penalties.
    expect(spoken).toEqual([
      "Principal, 25,000 U S D C",
      "Interest rate, 6.5 percent per year",
      "Term length, 2 years, 6 months",
      "Late payment penalty, 2.5 percent of the overdue amount",
      "Disbursed so far, 10,000 U S D C",
      "Repaid so far, 2,000 U S D C",
      "Remaining to disburse, 15,000 U S D C",
      "Current status, Active",
    ]);
  });

  it("orders terms as a sighted user reads them", () => {
    render(
      <LoanStatusCard
        loan={{
          status: "Active",
          principal: "25000",
          disbursed: "0",
          repaid: "0",
          interestRateBps: 650,
          termMonths: 30,
          lateFeeBps: 250,
        }}
      />
    );

    const spoken = narratable();
    const indexOf = (fragment: string) => spoken.findIndex((line) => line.startsWith(fragment));

    // What it is -> what it costs -> how long -> penalty -> progress.
    expect(indexOf("Principal")).toBeLessThan(indexOf("Interest rate"));
    expect(indexOf("Interest rate")).toBeLessThan(indexOf("Term length"));
    expect(indexOf("Term length")).toBeLessThan(indexOf("Late payment penalty"));
    expect(indexOf("Late payment penalty")).toBeLessThan(indexOf("Disbursed"));
    expect(indexOf("Repaid")).toBeLessThan(indexOf("Remaining"));
    expect(indexOf("Remaining")).toBeLessThan(indexOf("Current status"));
  });

  it("omits terms the caller did not supply", () => {
    render(
      <LoanStatusCard
        loan={{ status: "Active", principal: "25000", disbursed: "0", repaid: "0" }}
      />
    );

    const spoken = narratable();
    expect(spoken).toEqual([
      "Principal, 25,000 U S D C",
      "Disbursed so far, 0 U S D C",
      "Repaid so far, 0 U S D C",
      "Remaining to disburse, 25,000 U S D C",
      "Current status, Active",
    ]);
    expect(spoken.join(" ")).not.toMatch(/Interest rate/);
  });

  it("narration only when there is a loan", () => {
    render(
      <LoanStatusCard loan={{ status: "None", principal: "0", disbursed: "0", repaid: "0" }} />
    );

    expect(screen.getByText("No active loan")).toBeInTheDocument();
    expect(narratable()).toEqual([]);
  });

  it("keeps the visible figures unchanged alongside the spoken summaries", () => {
    render(
      <LoanStatusCard
        loan={{
          status: "Active",
          principal: "25000",
          disbursed: "10000",
          repaid: "2000",
          interestRateBps: 650,
          termMonths: 30,
        }}
      />
    );

    expect(screen.getByText("25,000 USDC")).toBeInTheDocument();
    expect(screen.getByText("6.50%")).toBeInTheDocument();
    expect(screen.getByText("30 months")).toBeInTheDocument();
    expect(screen.getByText("15,000 USDC")).toBeInTheDocument();
  });
});
