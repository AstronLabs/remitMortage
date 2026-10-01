// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { render, screen } from "@testing-library/react";
import EscrowMilestoneProgressMap, {
  computeEscrowRelease,
  findCurrentMilestoneIndex,
  mapMilestoneStateToEscrowStatus,
  toEscrowMilestoneItems,
  type EscrowMilestoneItem,
} from "../EscrowMilestoneProgressMap";
import type { MilestoneNode, MilestoneState } from "../MilestoneTimeline";

function milestone(id: string, state: MilestoneState, title = id): MilestoneNode {
  return { id, title, state, scheduledDate: "2026-01-01" };
}

function item(id: string, status: EscrowMilestoneItem["status"], isDisputed = false): EscrowMilestoneItem {
  return { id, title: id, status, isDisputed };
}

describe("mapMilestoneStateToEscrowStatus (issue #821)", () => {
  it("maps each governance state onto a borrower-facing status", () => {
    expect(mapMilestoneStateToEscrowStatus("Proposed")).toBe("pending");
    expect(mapMilestoneStateToEscrowStatus("Voting")).toBe("in-review");
    expect(mapMilestoneStateToEscrowStatus("Disputed")).toBe("in-review");
    expect(mapMilestoneStateToEscrowStatus("Approved")).toBe("approved");
    expect(mapMilestoneStateToEscrowStatus("Disbursed")).toBe("disbursed");
  });
});

describe("toEscrowMilestoneItems", () => {
  it("preserves order and flags disputed milestones separately from their mapped status", () => {
    const items = toEscrowMilestoneItems([
      milestone("m1", "Approved", "Foundation"),
      milestone("m2", "Disputed", "Framing"),
    ]);
    expect(items).toEqual([
      { id: "m1", title: "Foundation", status: "approved", isDisputed: false },
      { id: "m2", title: "Framing", status: "in-review", isDisputed: true },
    ]);
  });
});

describe("findCurrentMilestoneIndex", () => {
  it("returns the first not-yet-disbursed milestone", () => {
    const items = [item("m1", "disbursed"), item("m2", "approved"), item("m3", "pending")];
    expect(findCurrentMilestoneIndex(items)).toBe(1);
  });

  it("returns -1 when every milestone is disbursed", () => {
    expect(findCurrentMilestoneIndex([item("m1", "disbursed"), item("m2", "disbursed")])).toBe(-1);
  });

  it("returns -1 for an empty list", () => {
    expect(findCurrentMilestoneIndex([])).toBe(-1);
  });

  it("treats the very first milestone as current when nothing has progressed yet", () => {
    expect(findCurrentMilestoneIndex([item("m1", "pending")])).toBe(0);
  });
});

describe("computeEscrowRelease", () => {
  it("computes deposited/target as a percentage", () => {
    expect(computeEscrowRelease("50000", "200000")).toBe(25);
    expect(computeEscrowRelease("200000", "200000")).toBe(100);
  });

  it("clamps to [0, 100] and never throws on bad input", () => {
    expect(computeEscrowRelease("300000", "200000")).toBe(100);
    expect(computeEscrowRelease("-500", "200000")).toBe(0);
    expect(computeEscrowRelease("50000", "0")).toBe(0);
    expect(computeEscrowRelease("not-a-number", "200000")).toBe(0);
    expect(computeEscrowRelease("50000", "not-a-number")).toBe(0);
  });
});

describe("EscrowMilestoneProgressMap rendering (issue #821)", () => {
  const milestones: MilestoneNode[] = [
    milestone("m1", "Disbursed", "Site Prep"),
    milestone("m2", "Disbursed", "Foundation"),
    milestone("m3", "Approved", "Framing"),
    milestone("m4", "Voting", "Electrical"),
    milestone("m5", "Proposed", "Final Inspection"),
  ];

  it("renders every milestone as an ordered node with its status", () => {
    render(<EscrowMilestoneProgressMap milestones={milestones} escrow={{ deposited: "60000", target: "100000" }} />);

    const nodes = screen.getAllByTestId(/^escrow-milestone-node-/);
    expect(nodes.map((n) => n.getAttribute("data-testid"))).toEqual([
      "escrow-milestone-node-m1",
      "escrow-milestone-node-m2",
      "escrow-milestone-node-m3",
      "escrow-milestone-node-m4",
      "escrow-milestone-node-m5",
    ]);
    expect(nodes.map((n) => n.getAttribute("data-status"))).toEqual([
      "disbursed",
      "disbursed",
      "approved",
      "in-review",
      "pending",
    ]);
    expect(screen.getByText("Site Prep")).toBeInTheDocument();
    expect(screen.getByText("Final Inspection")).toBeInTheDocument();
  });

  it("marks the first not-yet-disbursed milestone as current, and no other", () => {
    render(<EscrowMilestoneProgressMap milestones={milestones} escrow={{ deposited: "60000", target: "100000" }} />);
    const nodes = screen.getAllByTestId(/^escrow-milestone-node-/);
    expect(nodes.map((n) => n.getAttribute("data-current"))).toEqual(["false", "false", "true", "false", "false"]);
    expect(screen.getByTestId("escrow-milestone-node-m3")).toHaveTextContent("Next up");
    expect(screen.getByTestId("escrow-milestone-node-m4")).not.toHaveTextContent("Next up");
  });

  it("shows no current milestone once every milestone is disbursed", () => {
    const allDisbursed = milestones.map((m) => ({ ...m, state: "Disbursed" as const }));
    render(<EscrowMilestoneProgressMap milestones={allDisbursed} escrow={{ deposited: "100000", target: "100000" }} />);
    for (const node of screen.getAllByTestId(/^escrow-milestone-node-/)) {
      expect(node).toHaveAttribute("data-current", "false");
    }
  });

  it("renders the cumulative escrow release percentage, not per-milestone counts", () => {
    render(<EscrowMilestoneProgressMap milestones={milestones} escrow={{ deposited: "37500", target: "150000" }} />);
    // 2 of 5 milestones disbursed would be 40% — the overlay must reflect the
    // dollar-based release (25%), not milestone count.
    expect(screen.getByTestId("escrow-release-percent")).toHaveTextContent("25%");
  });

  it("marks a disputed milestone distinctly from an ordinary in-review one", () => {
    const withDispute = [milestone("m1", "Voting", "Review"), milestone("m2", "Disputed", "Dispute")];
    render(<EscrowMilestoneProgressMap milestones={withDispute} escrow={{ deposited: "0", target: "100000" }} />);
    expect(screen.getByTestId("escrow-milestone-node-m1")).toHaveAttribute("data-disputed", "false");
    expect(screen.getByTestId("escrow-milestone-node-m2")).toHaveAttribute("data-disputed", "true");
    expect(screen.getByTestId("escrow-milestone-node-m2")).toHaveTextContent("Disputed");
  });

  it("renders nothing for an empty milestone list", () => {
    const { container } = render(<EscrowMilestoneProgressMap milestones={[]} escrow={{ deposited: "0", target: "100000" }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a single milestone without dividing by zero", () => {
    render(<EscrowMilestoneProgressMap milestones={[milestone("m1", "Approved")]} escrow={{ deposited: "10000", target: "100000" }} />);
    expect(screen.getByTestId("escrow-milestone-node-m1")).toHaveAttribute("data-current", "true");
  });
});
