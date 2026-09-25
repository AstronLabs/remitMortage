// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { render, screen } from "@testing-library/react";
import { MilestoneGanttChart, type GanttMilestone } from "../MilestoneGanttChart";

const SAMPLE_MILESTONES: GanttMilestone[] = [
  {
    id: "m1",
    title: "Foundation",
    status: "Disbursed",
    startDate: "2026-01-15",
    endDate: "2026-02-28",
    progress: 100,
    votesFor: 3,
    votesAgainst: 0,
    votesTotal: 3,
    description: "Foundation inspection completed",
  },
  {
    id: "m2",
    title: "Framing",
    status: "Approved",
    startDate: "2026-03-01",
    endDate: "2026-04-15",
    progress: 75,
    votesFor: 2,
    votesAgainst: 1,
    votesTotal: 3,
    description: "Framing and roof trusses",
  },
  {
    id: "m3",
    title: "Plumbing",
    status: "Voting",
    startDate: "2026-04-20",
    endDate: "2026-05-30",
    progress: 40,
    votesFor: 1,
    votesAgainst: 0,
    votesTotal: 3,
    description: "Plumbing rough-in",
  },
  {
    id: "m4",
    title: "Finishing",
    status: "Proposed",
    startDate: "2026-06-01",
    endDate: "2026-07-15",
    progress: 0,
    votesFor: 0,
    votesAgainst: 0,
    votesTotal: 3,
  },
];

describe("MilestoneGanttChart", () => {
  it("renders nothing when milestones are empty", () => {
    const { container } = render(<MilestoneGanttChart milestones={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders milestone titles", () => {
    render(<MilestoneGanttChart milestones={SAMPLE_MILESTONES} />);
    expect(screen.getByText("Foundation")).toBeInTheDocument();
    expect(screen.getByText("Framing")).toBeInTheDocument();
    expect(screen.getByText("Plumbing")).toBeInTheDocument();
    expect(screen.getByText("Finishing")).toBeInTheDocument();
  });

  it("renders the title when provided", () => {
    render(
      <MilestoneGanttChart milestones={SAMPLE_MILESTONES} title="Construction Milestones" />
    );
    expect(screen.getByText("Construction Milestones")).toBeInTheDocument();
  });

  it("renders status legend items", () => {
    render(<MilestoneGanttChart milestones={SAMPLE_MILESTONES} />);
    expect(screen.getByText("Proposed")).toBeInTheDocument();
    expect(screen.getByText("Voting")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText("Disbursed")).toBeInTheDocument();
    expect(screen.getByText("Disputed")).toBeInTheDocument();
  });

  it("renders a sort select", () => {
    render(<MilestoneGanttChart milestones={SAMPLE_MILESTONES} />);
    expect(screen.getByTestId("sort-select")).toBeInTheDocument();
  });

  it("renders the SVG chart area", () => {
    render(<MilestoneGanttChart milestones={SAMPLE_MILESTONES} />);
    expect(screen.getByRole("region")).toBeInTheDocument();
  });

  it("shows progress percentage for each milestone", () => {
    render(<MilestoneGanttChart milestones={SAMPLE_MILESTONES} />);
    expect(screen.getByText(/100%/)).toBeInTheDocument();
    expect(screen.getByText(/75%/)).toBeInTheDocument();
    expect(screen.getByText(/40%/)).toBeInTheDocument();
    expect(screen.getByText(/(?<!\d)0%/)).toBeInTheDocument();
  });

  it("renders status labels in the SVG for each milestone", () => {
    render(<MilestoneGanttChart milestones={SAMPLE_MILESTONES} />);
    expect(screen.getByText("Disbursed")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText("Voting")).toBeInTheDocument();
    expect(screen.getByText("Proposed")).toBeInTheDocument();
  });
});
