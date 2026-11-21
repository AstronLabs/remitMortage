// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { parseTokenAmount } from "../annualInterestStatement";
import {
  buildMonthlyInvestorStatement,
  buildMonthlyInvestorStatementPayload,
  listStatementMonths,
  monthlyStatementFilename,
  signedAmount,
  toStatementMonth,
  type InvestorTransaction,
} from "../monthlyInvestorStatement";
import { buildStatementPdf, type StatementMetadata } from "../statementExport";

const tx = (
  id: string,
  type: InvestorTransaction["type"],
  date: string,
  amount: string
): InvestorTransaction => ({ id, type, date, amount: parseTokenAmount(amount), txHash: `hash-${id}` });

/** Source ledger used across tests; amounts use full 7-decimal precision. */
const LEDGER: InvestorTransaction[] = [
  tx("d1", "deposit", "2026-01-14T10:05:00Z", "5000.00"),
  tx("y1", "yield", "2026-01-31T23:59:59Z", "12.3456789"),
  tx("d2", "deposit", "2026-02-01T00:00:00Z", "2500.00"),
  tx("w1", "withdrawal", "2026-02-10T15:45:00Z", "1200.5000001"),
  tx("y2", "yield", "2026-02-28T23:00:00Z", "48.1200000"),
  tx("y2b", "yield", "2026-02-15T12:00:00Z", "0.0000001"),
  tx("d3", "deposit", "2026-04-02T09:00:00Z", "100.00"),
];

const METADATA: StatementMetadata = {
  borrowerName: "Investor GTEST…ABCD",
  borrowerAddress: "GTESTNETINVESTORADDRESS",
  walletType: "Freighter / Stellar",
  generatedAt: "2026-11-21T00:00:00.000Z",
};

/** Independent reference: sum the raw records for a month by type. */
function sumByType(month: string, type: InvestorTransaction["type"]): bigint {
  return LEDGER.filter((t) => t.type === type && toStatementMonth(t.date) === month).reduce(
    (total, t) => total + t.amount,
    0n
  );
}

describe("buildMonthlyInvestorStatement", () => {
  it("matches the source transactions for the month exactly", () => {
    const statement = buildMonthlyInvestorStatement(LEDGER, "2026-02");

    expect(statement.deposits).toBe(sumByType("2026-02", "deposit"));
    expect(statement.withdrawals).toBe(sumByType("2026-02", "withdrawal"));
    expect(statement.yieldEarned).toBe(sumByType("2026-02", "yield"));
    expect(statement.deposits).toBe(parseTokenAmount("2500.00"));
    expect(statement.withdrawals).toBe(parseTokenAmount("1200.5000001"));
    expect(statement.yieldEarned).toBe(parseTokenAmount("48.1200001"));

    // Opening balance is January's net; closing is the net of every record up to month end.
    expect(statement.openingBalance).toBe(parseTokenAmount("5012.3456789"));
    const netThroughFebruary = LEDGER.filter((t) => Date.parse(t.date) < Date.parse("2026-03-01T00:00:00Z"))
      .map(signedAmount)
      .reduce((a, b) => a + b, 0n);
    expect(statement.closingBalance).toBe(netThroughFebruary);

    // Exactly the month's records, chronological, with month boundaries respected.
    expect(statement.transactions.map((t) => t.id)).toEqual(["d2", "w1", "y2b", "y2"]);
  });

  it("chains closing balance into the next month's opening balance", () => {
    const january = buildMonthlyInvestorStatement(LEDGER, "2026-01");
    const february = buildMonthlyInvestorStatement(LEDGER, "2026-02");
    const march = buildMonthlyInvestorStatement(LEDGER, "2026-03");

    expect(january.openingBalance).toBe(0n);
    expect(february.openingBalance).toBe(january.closingBalance);
    expect(march.openingBalance).toBe(february.closingBalance);
  });

  it("produces a valid statement for a month with no activity", () => {
    const march = buildMonthlyInvestorStatement(LEDGER, "2026-03");
    const february = buildMonthlyInvestorStatement(LEDGER, "2026-02");

    expect(march.transactions).toEqual([]);
    expect(march.deposits).toBe(0n);
    expect(march.withdrawals).toBe(0n);
    expect(march.yieldEarned).toBe(0n);
    expect(march.openingBalance).toBe(february.closingBalance);
    expect(march.closingBalance).toBe(march.openingBalance);
    expect(march.periodStart).toBe("2026-03-01T00:00:00.000Z");
    expect(march.periodEnd).toBe("2026-04-01T00:00:00.000Z");

    const payload = buildMonthlyInvestorStatementPayload(march, METADATA);
    expect(payload.rows).toEqual([]);
    expect(payload.emptyRowsMessage).toMatch(/No activity/);
    expect(payload.summary).toEqual(
      expect.arrayContaining([
        { label: "Deposits", value: "0.00 USDC" },
        { label: "Transactions Recorded", value: "0" },
      ])
    );

    // The PDF renders without error and carries the no-activity message.
    const doc = buildStatementPdf(payload);
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
    const source = doc.output();
    expect(source.startsWith("%PDF-")).toBe(true);
    expect(source).toContain("No activity was recorded on this account during the month.");
    expect(source).toContain("Monthly Investor Statement - March 2026");
    expect(source).toContain("Closing Balance: 6,359.9656789 USDC");
  });

  it("rejects a malformed month key", () => {
    expect(() => buildMonthlyInvestorStatement(LEDGER, "2026-13")).toThrow(/Invalid statement month/);
  });
});

describe("buildMonthlyInvestorStatementPayload", () => {
  it("renders the statement figures and every source transaction", () => {
    const statement = buildMonthlyInvestorStatement(LEDGER, "2026-02");
    const payload = buildMonthlyInvestorStatementPayload(statement, METADATA);

    expect(payload.title).toBe("Monthly Investor Statement - February 2026");
    expect(payload.metadataHeading).toBe("Investor account");
    const summary = Object.fromEntries(payload.summary.map((item) => [item.label, item.value]));
    expect(summary["Deposits"]).toBe("2,500.00 USDC");
    expect(summary["Withdrawals"]).toBe("1,200.5000001 USDC");
    expect(summary["Transactions Recorded"]).toBe("4");
    expect(payload.rows.map((row) => row.reference)).toEqual([
      "hash-d2",
      "hash-w1",
      "hash-y2b",
      "hash-y2",
    ]);
    expect(payload.rows[1].amount.startsWith("-")).toBe(true);
    expect(monthlyStatementFilename(statement.month)).toBe("Investor_Statement_2026-02.pdf");
  });
});

describe("listStatementMonths", () => {
  it("lists every completed month since the account opened, newest first", () => {
    expect(listStatementMonths("2026-01-14T10:00:00Z", new Date("2026-05-03T00:00:00Z"))).toEqual([
      "2026-04",
      "2026-03",
      "2026-02",
      "2026-01",
    ]);
  });

  it("spans year boundaries", () => {
    expect(listStatementMonths("2025-11-30T23:00:00Z", new Date("2026-02-01T00:00:00Z"))).toEqual([
      "2026-01",
      "2025-12",
      "2025-11",
    ]);
  });

  it("returns nothing before the first month has ended or for a bad date", () => {
    expect(listStatementMonths("2026-11-02T00:00:00Z", new Date("2026-11-21T00:00:00Z"))).toEqual([]);
    expect(listStatementMonths("not-a-date")).toEqual([]);
  });
});
