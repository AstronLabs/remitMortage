import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PortfolioBreakdownChart from "../src/components/PortfolioBreakdownChart";
import type { PortfolioSegment } from "../src/lib/portfolioBreakdown";

const SEGMENTS: PortfolioSegment[] = [
  {
    tranche: "Senior",
    riskTier: "Low",
    amount: 6000,
    loans: [
      {
        loanId: "loan-1",
        borrower: "GBORROWER1111111111111111111111111111111111111111111",
        region: "North America",
        tranche: "Senior",
        riskTier: "Low",
        allocatedAmount: 6000,
        apyBps: 400,
      },
    ],
  },
  {
    tranche: "Senior",
    riskTier: "Medium",
    amount: 1000,
    loans: [
      {
        loanId: "loan-2",
        borrower: "GBORROWER2222222222222222222222222222222222222222222",
        region: "Europe",
        tranche: "Senior",
        riskTier: "Medium",
        allocatedAmount: 1000,
        apyBps: 480,
      },
    ],
  },
  {
    tranche: "Junior",
    riskTier: "High",
    amount: 3000,
    loans: [
      {
        loanId: "loan-3",
        borrower: "GBORROWER3333333333333333333333333333333333333333333",
        region: "Asia Pacific",
        tranche: "Junior",
        riskTier: "High",
        allocatedAmount: 1800,
        apyBps: 950,
      },
      {
        loanId: "loan-4",
        borrower: "GBORROWER4444444444444444444444444444444444444444444",
        region: "Africa & ME",
        tranche: "Junior",
        riskTier: "High",
        allocatedAmount: 1200,
        apyBps: 990,
      },
    ],
  },
];

const RESPONSE = {
  wallet: "GABC",
  totalDeposited: 10000,
  segments: SEGMENTS,
};

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => RESPONSE,
  }) as jest.Mock;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("PortfolioBreakdownChart", () => {
  it("renders nothing when there is no wallet", () => {
    const { container } = render(<PortfolioBreakdownChart wallet={null} />);
    expect(container.firstChild).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fetches the breakdown for the given wallet", async () => {
    render(<PortfolioBreakdownChart wallet="GABC" totalDeposited={10000} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(String(url)).toContain("/api/investor/portfolio-breakdown");
    expect(String(url)).toContain("wallet=GABC");
  });

  it("renders both tranche rows with their totals", async () => {
    render(<PortfolioBreakdownChart wallet="GABC" totalDeposited={10000} />);
    await screen.findByText("Senior Tranche");
    expect(screen.getByText("Junior Tranche")).toBeInTheDocument();
    expect(screen.getByText("$10,000.00")).toBeInTheDocument(); // grand total
    expect(screen.getByText("$7,000.00")).toBeInTheDocument(); // Senior total
    expect(screen.getByText("$3,000.00")).toBeInTheDocument(); // Junior total
  });

  it("shows no drill-down panel before a segment is selected", async () => {
    render(<PortfolioBreakdownChart wallet="GABC" totalDeposited={10000} />);
    await screen.findByText("Senior Tranche");
    expect(screen.queryByText(/loans\)/)).not.toBeInTheDocument();
  });

  it("drilling into a segment shows exactly the loans backing it", async () => {
    render(<PortfolioBreakdownChart wallet="GABC" totalDeposited={10000} />);
    await screen.findByText("Senior Tranche");

    fireEvent.click(screen.getByText("High: $3,000.00"));

    expect(await screen.findByText("Junior · High Risk")).toBeInTheDocument();
    expect(screen.getByText("(2 loans)")).toBeInTheDocument();
    expect(screen.getByText(/GBORROWER3\.\.\./)).toBeInTheDocument();
    expect(screen.getByText(/GBORROWER4\.\.\./)).toBeInTheDocument();
    // Loans from other segments must not leak into this drill-down.
    expect(screen.queryByText(/GBORROWER1\.\.\./)).not.toBeInTheDocument();
    expect(screen.queryByText(/GBORROWER2\.\.\./)).not.toBeInTheDocument();
  });

  it("switches the drill-down when a different segment is selected", async () => {
    render(<PortfolioBreakdownChart wallet="GABC" totalDeposited={10000} />);
    await screen.findByText("Senior Tranche");

    fireEvent.click(screen.getByText("High: $3,000.00"));
    await screen.findByText("Junior · High Risk");

    fireEvent.click(screen.getByText("Low: $6,000.00"));

    expect(await screen.findByText("Senior · Low Risk")).toBeInTheDocument();
    expect(screen.getByText(/GBORROWER1\.\.\./)).toBeInTheDocument();
    expect(screen.queryByText(/GBORROWER3\.\.\./)).not.toBeInTheDocument();
  });

  it("clears the drill-down when clicking the same segment again", async () => {
    render(<PortfolioBreakdownChart wallet="GABC" totalDeposited={10000} />);
    await screen.findByText("Senior Tranche");

    fireEvent.click(screen.getByText("Low: $6,000.00"));
    await screen.findByText("Senior · Low Risk");

    fireEvent.click(screen.getByText("Low: $6,000.00"));
    expect(screen.queryByText("Senior · Low Risk")).not.toBeInTheDocument();
  });

  it("clears the drill-down via the Clear button", async () => {
    render(<PortfolioBreakdownChart wallet="GABC" totalDeposited={10000} />);
    await screen.findByText("Senior Tranche");

    fireEvent.click(screen.getByText("Medium: $1,000.00"));
    await screen.findByText("Senior · Medium Risk");

    fireEvent.click(screen.getByText("Clear"));
    expect(screen.queryByText("Senior · Medium Risk")).not.toBeInTheDocument();
  });

  it("shows an empty state when there is no deposited capital", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ wallet: "GABC", totalDeposited: 0, segments: [] }),
    });
    render(<PortfolioBreakdownChart wallet="GABC" totalDeposited={0} />);
    expect(await screen.findByText(/No deposited capital/i)).toBeInTheDocument();
  });

  it("shows an error state when the fetch fails", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, json: async () => ({}) });
    render(<PortfolioBreakdownChart wallet="GABC" totalDeposited={10000} />);
    expect(await screen.findByText(/Failed to load portfolio breakdown/i)).toBeInTheDocument();
  });
});
