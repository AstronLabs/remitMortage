// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AccessibleChart from "../AccessibleChart";
import type { ChartExportData } from "@/lib/chart-export";

const DATA: ChartExportData = {
  columns: ["Month", "Deposits (USDC)", "Repayments (USDC)"],
  rows: [
    ["2026-01", 1000, 250.5],
    ["2026-02", 1200, 300],
    ["2026-03", 1500.25, 410],
  ],
};

/** Stand-in chart that renders the same rows it was given, as a plotted series. */
function FakeChart({ data }: { data: ChartExportData }) {
  return (
    <svg data-testid="fake-chart">
      {data.rows.map((row) => (
        <circle key={String(row[0])} data-x={row[0]} data-y1={row[1]} data-y2={row[2]} />
      ))}
    </svg>
  );
}

function renderChart(overrides: Partial<React.ComponentProps<typeof AccessibleChart>> = {}) {
  return render(
    <AccessibleChart
      chartTitle="Volume Trends"
      summary="Deposits rose 50.0% from $1,000 in 2026-01 to $1,500.25 in 2026-03."
      data={DATA}
      filterDescription="Time range: 1y."
      {...overrides}
    >
      <FakeChart data={DATA} />
    </AccessibleChart>
  );
}

describe("AccessibleChart", () => {
  it("shows the trend summary above the chart and the table is hidden by default", () => {
    renderChart();
    expect(screen.getByText(/Deposits rose 50.0%/)).toBeInTheDocument();
    expect(screen.getByTestId("fake-chart")).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("toggles to a table and back, keeping the chart mounted", async () => {
    const user = userEvent.setup();
    renderChart();
    const toggle = screen.getByRole("button", { name: /view as table/i });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.click(toggle);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByTestId("fake-chart")).not.toBeVisible();
    expect(screen.getByRole("button", { name: /view as chart/i })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("status")).toHaveTextContent(/data table with 3 rows/i);

    await user.click(screen.getByRole("button", { name: /view as chart/i }));
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByTestId("fake-chart")).toBeVisible();
  });

  it("table values match the plotted chart data exactly", async () => {
    const user = userEvent.setup();
    renderChart();
    await user.click(screen.getByRole("button", { name: /view as table/i }));

    const table = screen.getByRole("table");
    const bodyRows = within(table).getAllByRole("row").slice(1);
    const plotted = Array.from(screen.getByTestId("fake-chart").querySelectorAll("circle"));
    expect(bodyRows).toHaveLength(plotted.length);

    bodyRows.forEach((row, i) => {
      const cells = within(row).getAllByRole("cell");
      expect(within(row).getByRole("rowheader")).toHaveTextContent(
        plotted[i].getAttribute("data-x")!
      );
      expect(Number(cells[0].textContent!.replace(/,/g, ""))).toBe(
        Number(plotted[i].getAttribute("data-y1"))
      );
      expect(Number(cells[1].textContent!.replace(/,/g, ""))).toBe(
        Number(plotted[i].getAttribute("data-y2"))
      );
    });
  });

  it("uses proper headers and a caption that includes the active filter", async () => {
    const user = userEvent.setup();
    renderChart();
    await user.click(screen.getByRole("button", { name: /view as table/i }));

    const table = screen.getByRole("table", { name: /Volume Trends\. Time range: 1y\./ });
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual(DATA.columns);
    headers.forEach((h) => expect(h).toHaveAttribute("scope", "col"));
  });

  it("is keyboard operable: toggle via Enter/Space and a focusable scroll region", async () => {
    const user = userEvent.setup();
    renderChart();
    await user.tab();
    const toggle = screen.getByRole("button", { name: /view as table/i });
    expect(toggle).toHaveFocus();

    await user.keyboard("{Enter}");
    const region = screen.getByRole("region", { name: /Volume Trends data table/i });
    expect(region).toHaveAttribute("tabindex", "0");
    // Focus stays on the toggle so the user keeps their place; Tab reaches the table region.
    expect(screen.getByRole("button", { name: /view as chart/i })).toHaveFocus();
    await user.tab();
    expect(region).toHaveFocus();

    await user.tab({ shift: true });
    await user.keyboard(" ");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("applies a custom cell formatter", async () => {
    const user = userEvent.setup();
    renderChart({ formatCell: (v, col) => (col > 0 ? `$${v}` : String(v)) });
    await user.click(screen.getByRole("button", { name: /view as table/i }));
    expect(screen.getByText("$1000")).toBeInTheDocument();
  });
});
