// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Review step before a bulk admin action takes effect (issue #1109).
 */

import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BulkActionReviewDialog, type BulkReviewRow } from "../BulkActionReviewDialog";

function makeRows(count: number): BulkReviewRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `loan-${index + 1}`,
    label: `GBORROWER${String(index + 1).padStart(3, "0")}`,
    detail: `loan-${index + 1} · ${(index + 1) * 1000} USDC · Pending`,
  }));
}

function renderDialog(
  rows: BulkReviewRow[],
  overrides: Partial<React.ComponentProps<typeof BulkActionReviewDialog>> = {}
) {
  const onConfirm = jest.fn();
  const onCancel = jest.fn();
  render(
    <BulkActionReviewDialog
      title="Review bulk approval"
      change={{ field: "Status", from: "Pending", to: "Approved" }}
      rows={rows}
      confirmLabel="Bulk approve"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />
  );
  return { onConfirm, onCancel };
}

function rowList() {
  return within(screen.getByTestId("bulk-review-rows")).getAllByRole("listitem");
}

describe("BulkActionReviewDialog", () => {
  it("lists every affected row and the exact change before anything is applied", () => {
    const rows = makeRows(3);
    const { onConfirm } = renderDialog(rows);

    expect(rowList()).toHaveLength(3);
    for (const row of rows) {
      expect(screen.getByText(row.label)).toBeInTheDocument();
      expect(screen.getByText(row.detail!)).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: `Include ${row.label}` })).toBeChecked();
    }
    expect(screen.getByTestId("bulk-review-change")).toHaveTextContent(
      "Change: Status: Pending → Approved"
    );
    expect(screen.getByTestId("bulk-review-summary")).toHaveTextContent(
      "3 of 3 selected rows will change."
    );
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("applies the action only to the rows still included after deselecting one", async () => {
    const { onConfirm } = renderDialog(makeRows(3));

    fireEvent.click(screen.getByRole("checkbox", { name: "Include GBORROWER002" }));

    expect(screen.getByTestId("bulk-review-summary")).toHaveTextContent(
      "2 of 3 selected rows will change. 1 excluded."
    );
    fireEvent.click(screen.getByRole("button", { name: "Bulk approve (2)" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(["loan-1", "loan-3"]));
  });

  it("can re-include a deselected row", async () => {
    const { onConfirm } = renderDialog(makeRows(2));

    fireEvent.click(screen.getByRole("checkbox", { name: "Include GBORROWER001" }));
    fireEvent.click(screen.getByRole("button", { name: "Include all 2 again" }));
    fireEvent.click(screen.getByRole("button", { name: "Bulk approve (2)" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(["loan-1", "loan-2"]));
  });

  it("blocks confirming once every row has been deselected", () => {
    const { onConfirm } = renderDialog(makeRows(1));

    fireEvent.click(screen.getByRole("checkbox", { name: "Include GBORROWER001" }));
    const confirm = screen.getByRole("button", { name: "Bulk approve (0)" });

    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("still requires the typed confirmation when one is set", async () => {
    const { onConfirm } = renderDialog(makeRows(2), { confirmationText: "APPROVE" });
    const confirm = screen.getByRole("button", { name: "Bulk approve (2)" });

    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/to continue/), { target: { value: "APPROVE" } });
    fireEvent.click(confirm);

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(["loan-1", "loan-2"]));
  });

  it("shows a change without a 'from' value", () => {
    renderDialog(makeRows(1), { change: { field: "Assigned reviewer", to: "GREVIEWER" } });

    expect(screen.getByTestId("bulk-review-change")).toHaveTextContent(
      "Change: Assigned reviewer → GREVIEWER"
    );
  });

  describe("large selections", () => {
    it("renders a summary count and a sample instead of every row", () => {
      renderDialog(makeRows(500));

      expect(screen.getByTestId("bulk-review-summary")).toHaveTextContent(
        "500 of 500 selected rows will change."
      );
      expect(rowList()).toHaveLength(20);
      expect(screen.getByTestId("bulk-review-hidden-count")).toHaveTextContent(
        "…and 480 more rows not shown."
      );
      expect(
        screen.getByLabelText(/Showing a sample of 20\. Search all 500 rows/)
      ).toBeInTheDocument();
    });

    it("finds a row outside the sample by search and excludes it from the action", async () => {
      const { onConfirm } = renderDialog(makeRows(500));
      expect(screen.queryByText("GBORROWER321")).not.toBeInTheDocument();

      fireEvent.change(screen.getByRole("searchbox"), { target: { value: "GBORROWER321" } });
      expect(rowList()).toHaveLength(1);
      fireEvent.click(screen.getByRole("checkbox", { name: "Include GBORROWER321" }));
      fireEvent.click(screen.getByRole("button", { name: "Bulk approve (499)" }));

      await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
      const ids: string[] = onConfirm.mock.calls[0][0];
      expect(ids).toHaveLength(499);
      expect(ids).not.toContain("loan-321");
    });

    it("renders every row at or below the threshold", () => {
      renderDialog(makeRows(50));

      expect(rowList()).toHaveLength(50);
      expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    });

    it("honours a custom threshold and sample size", () => {
      renderDialog(makeRows(12), { sampleThreshold: 10, sampleSize: 5 });

      expect(rowList()).toHaveLength(5);
      expect(screen.getByTestId("bulk-review-hidden-count")).toHaveTextContent(
        "…and 7 more rows not shown."
      );
    });
  });
});
