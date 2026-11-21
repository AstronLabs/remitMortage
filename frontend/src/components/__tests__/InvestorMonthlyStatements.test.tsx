// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import InvestorMonthlyStatements from "../InvestorMonthlyStatements";
import { parseTokenAmount } from "@/lib/annualInterestStatement";
import type { InvestorTransaction } from "@/lib/monthlyInvestorStatement";

const tx = (
  id: string,
  type: InvestorTransaction["type"],
  date: string,
  amount: string
): InvestorTransaction => ({ id, type, date, amount: parseTokenAmount(amount) });

const TRANSACTIONS: InvestorTransaction[] = [
  tx("d1", "deposit", "2026-01-14T10:05:00Z", "5000.00"),
  tx("y1", "yield", "2026-01-31T23:00:00Z", "12.50"),
  tx("w1", "withdrawal", "2026-02-10T12:00:00Z", "1000.00"),
  tx("y2", "yield", "2026-02-28T23:00:00Z", "20.25"),
  // March has no activity.
];

const NOW = new Date("2026-04-10T00:00:00Z");

describe("InvestorMonthlyStatements", () => {
  it("lists a statement for every past month the account has been open", () => {
    render(
      <InvestorMonthlyStatements
        transactions={TRANSACTIONS}
        accountOpenedAt="2026-01-14T10:00:00Z"
        onDownload={jest.fn()}
        now={NOW}
      />
    );

    const list = screen.getByTestId("statement-month-list");
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "March 2026",
      "February 2026",
      "January 2026",
    ]);
    expect(screen.getByRole("button", { name: "Download January 2026 statement as PDF" })).toBeInTheDocument();
  });

  it("shows a no-activity month as a valid statement with carried-over balances", () => {
    render(
      <InvestorMonthlyStatements
        transactions={TRANSACTIONS}
        accountOpenedAt="2026-01-14T10:00:00Z"
        onDownload={jest.fn()}
        now={NOW}
      />
    );

    // Newest month (March, no activity) is selected by default.
    expect(screen.getByRole("heading", { name: "March 2026" })).toBeInTheDocument();
    expect(screen.getByTestId("statement-no-activity")).toBeInTheDocument();
    expect(screen.getByTestId("statement-deposits")).toHaveTextContent("0.00 USDC");
    expect(screen.getByTestId("statement-opening")).toHaveTextContent("4,032.75 USDC");
    expect(screen.getByTestId("statement-closing")).toHaveTextContent("4,032.75 USDC");
  });

  it("shows a month's figures from its transactions and downloads that month", async () => {
    const user = userEvent.setup();
    const onDownload = jest.fn();
    render(
      <InvestorMonthlyStatements
        transactions={TRANSACTIONS}
        accountOpenedAt="2026-01-14T10:00:00Z"
        onDownload={onDownload}
        now={NOW}
      />
    );

    await user.click(screen.getByRole("button", { name: "February 2026" }));

    expect(screen.getByTestId("statement-opening")).toHaveTextContent("5,012.50 USDC");
    expect(screen.getByTestId("statement-withdrawals")).toHaveTextContent("1,000.00 USDC");
    expect(screen.getByTestId("statement-yield")).toHaveTextContent("20.25 USDC");
    expect(screen.getByTestId("statement-closing")).toHaveTextContent("4,032.75 USDC");

    await user.click(screen.getByRole("button", { name: "Download PDF" }));
    expect(onDownload).toHaveBeenCalledWith(
      expect.objectContaining({ month: "2026-02", closingBalance: parseTokenAmount("4032.75") })
    );
  });

  it("explains when no month has finished yet", () => {
    render(
      <InvestorMonthlyStatements
        transactions={[]}
        accountOpenedAt="2026-04-02T00:00:00Z"
        onDownload={jest.fn()}
        now={NOW}
      />
    );
    expect(screen.getByText("No statements yet")).toBeInTheDocument();
  });
});
