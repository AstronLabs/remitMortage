// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import InvestorRebalancingSuggestions from "../investor/InvestorRebalancingSuggestions";
import { computeConcentrationMetrics } from "../../lib/investorRebalancing";

describe("InvestorRebalancingSuggestions Component", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("does not render when portfolio is balanced", () => {
    const analysis = computeConcentrationMetrics(
      [
        { tranche: "Senior", amount: 5000 },
        { tranche: "Junior", amount: 5000 },
      ],
      0.7
    );

    const { container } = render(
      <InvestorRebalancingSuggestions analysis={analysis} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders non-blocking suggestion when concentration exceeds threshold", () => {
    const analysis = computeConcentrationMetrics(
      [
        { tranche: "Senior", amount: 9000 },
        { tranche: "Junior", amount: 1000 },
      ],
      0.7,
      { seniorApyBps: 400, juniorApyBps: 620 }
    );

    render(<InvestorRebalancingSuggestions analysis={analysis} />);

    expect(screen.getByText(/Auto-Diversification Suggestion/i)).toBeInTheDocument();
    expect(screen.getByText(/90% Concentrated/i)).toBeInTheDocument();
    expect(screen.getByText(/High concentration detected: 90.0% in Senior Tranche/i)).toBeInTheDocument();
    expect(screen.getByText(/Junior Tranche/i)).toBeInTheDocument();
  });

  it("triggers onSelectTranche when user clicks diversify button", () => {
    const onSelectTranche = jest.fn();
    const analysis = computeConcentrationMetrics(
      [{ tranche: "Senior", amount: 10000 }],
      0.7
    );

    render(
      <InvestorRebalancingSuggestions
        analysis={analysis}
        onSelectTranche={onSelectTranche}
      />
    );

    const diversifyBtn = screen.getByRole("button", { name: /Diversify into Junior/i });
    fireEvent.click(diversifyBtn);

    expect(onSelectTranche).toHaveBeenCalledWith("Junior", expect.any(Number));
  });

  it("dismisses per-occurrence without permanently blocking future occurrences", () => {
    const onDismiss = jest.fn();
    const analysis = computeConcentrationMetrics(
      [{ tranche: "Senior", amount: 10000 }],
      0.7
    );

    const { rerender } = render(
      <InvestorRebalancingSuggestions
        analysis={analysis}
        onDismiss={onDismiss}
      />
    );

    const dismissBtn = screen.getByRole("button", { name: /Dismiss/i });
    fireEvent.click(dismissBtn);

    expect(onDismiss).toHaveBeenCalled();
    // After dismissal, component is hidden
    expect(screen.queryByText(/Auto-Diversification Suggestion/i)).not.toBeInTheDocument();

    // A new concentration event occurs
    const newAnalysis = computeConcentrationMetrics(
      [{ tranche: "Senior", amount: 20000 }],
      0.7
    );

    rerender(
      <InvestorRebalancingSuggestions
        analysis={newAnalysis}
        onDismiss={onDismiss}
      />
    );

    // New occurrence is NOT suppressed
    expect(screen.getByText(/Auto-Diversification Suggestion/i)).toBeInTheDocument();
  });
});
