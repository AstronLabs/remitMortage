import React from "react";
import { render, screen } from "@testing-library/react";
import RefinanceEligibilityWidget from "../src/components/RefinanceEligibilityWidget";

const GOOD = {
  monthsSinceOrigination: 12,
  currentRateBps: 650,
  offeredRateBps: 550,
  onTimePaymentRatio: 0.98,
  isDelinquent: false,
};

describe("RefinanceEligibilityWidget", () => {
  it("shows eligible state with a link into the refinance flow", () => {
    render(<RefinanceEligibilityWidget loan={GOOD} />);
    expect(screen.getByTestId("refinance-eligible")).toBeInTheDocument();
    const cta = screen.getByTestId("refinance-cta");
    expect(cta).toHaveAttribute("href", expect.stringContaining("refinance"));
  });

  it("states the specific blocking reason(s) when not eligible", () => {
    render(
      <RefinanceEligibilityWidget
        loan={{ ...GOOD, monthsSinceOrigination: 1, isDelinquent: true }}
      />
    );
    expect(screen.getByTestId("refinance-not-eligible")).toBeInTheDocument();
    const reasons = screen.getAllByTestId("refinance-blocking-reason");
    expect(reasons.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByTestId("refinance-cta")).not.toBeInTheDocument();
  });
});
