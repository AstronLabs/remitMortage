import React from "react";
import { describe, expect, it, jest } from "@jest/globals";
import "@testing-library/jest-dom/jest-globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import VirtualizedTable from "../VirtualizedTable";

interface TestRow {
  id: string;
  label: string;
}

const makeRows = (count: number): TestRow[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `tx-${index}`,
    label: `Transaction ${index}`,
  }));

const ROWS = makeRows(10_000);

function renderTable(
  items = ROWS,
  viewportHeight = 300,
  columnCount = 1,
  rowHeight = 40,
  overscan = 3,
  selectedKeys: ReadonlySet<string> = new Set(),
  onSelectionChange?: (key: string, selected: boolean) => void
) {
  return (
    <VirtualizedTable
      items={items}
      getItemKey={(row) => row.id}
      ariaLabel="Transaction audit log"
      columnCount={columnCount + (onSelectionChange ? 1 : 0)}
      selectedKeys={selectedKeys}
      viewportHeight={viewportHeight}
      rowHeight={rowHeight}
      overscan={overscan}
      className="w-full"
      header={
        <thead>
          <tr aria-rowindex={1}>
            {onSelectionChange && <th scope="col">Select</th>}
            <th scope="col">Date</th>
            {columnCount === 5 && (
              <>
                <th scope="col">Type</th>
                <th scope="col">Amount</th>
                <th scope="col">Status</th>
                <th scope="col">Transaction</th>
              </>
            )}
          </tr>
        </thead>
      }
      renderRow={(row, index, tabIndex, ariaRowIndex, selected) => (
        <tr aria-rowindex={ariaRowIndex} style={{ height: rowHeight }}>
          {onSelectionChange && (
            <td>
              <input
                type="checkbox"
                aria-label={`Select ${row.label}`}
                checked={selected}
                onChange={(event) => onSelectionChange(row.id, event.target.checked)}
              />
            </td>
          )}
          {columnCount === 5 ? (
            <>
              <td>Oct 22, 2026</td>
              <td>Deposit</td>
              <td>1.00 USDC</td>
              <td>Success</td>
            </>
          ) : null}
          <td>
            <a
              href={`#${row.id}`}
              data-virtualized-row-index={index}
              tabIndex={tabIndex}
            >
              {row.label}
            </a>
          </td>
        </tr>
      )}
    />
  );
}

function setViewportHeight(viewport: HTMLElement, height: number) {
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: height });
}

describe("VirtualizedTable", () => {
  it("renders only the visible rows and overscan for a 10,000-row dataset", () => {
    render(renderTable());

    expect(screen.getByRole("table", { name: "Transaction audit log" })).toHaveAttribute(
      "aria-rowcount",
      "10001"
    );
    expect(screen.getAllByRole("row").length).toBeLessThanOrEqual(12);
    expect(screen.getByText("Transaction 0")).toBeInTheDocument();
    expect(screen.queryByText("Transaction 9999")).not.toBeInTheDocument();
  });

  it("renders the correct range after scrolling", async () => {
    render(renderTable());
    const viewport = screen.getByTestId("virtualized-table-viewport");
    setViewportHeight(viewport, 200);
    viewport.scrollTop = 40 * 40;
    fireEvent.scroll(viewport);

    await waitFor(() => expect(screen.getByText("Transaction 40")).toBeInTheDocument());
    expect(screen.getByText("Transaction 40").closest("tr")).toHaveAttribute(
      "aria-rowindex",
      "42"
    );
    expect(screen.queryByText("Transaction 0")).not.toBeInTheDocument();
    expect(viewport.querySelectorAll('a[tabindex="0"]')).toHaveLength(1);
  });

  it("keeps keyboard focus on the next transaction while scrolling virtual rows", async () => {
    render(renderTable(ROWS, 120));
    const viewport = screen.getByTestId("virtualized-table-viewport");
    setViewportHeight(viewport, 120);

    let link = screen.getByText("Transaction 0");
    link.focus();
    for (let index = 1; index <= 8; index += 1) {
      fireEvent.keyDown(link, { key: "ArrowDown" });
      link = await screen.findByText(`Transaction ${index}`);
    }

    await waitFor(() => expect(link).toHaveFocus());
    expect(viewport.scrollTop).toBeGreaterThan(0);
    expect(link).toHaveAttribute("tabindex", "0");
  });

  it("preserves the visible item's scroll position when earlier rows are added", async () => {
    const { rerender } = render(renderTable());
    const viewport = screen.getByTestId("virtualized-table-viewport");
    setViewportHeight(viewport, 200);
    viewport.scrollTop = 40 * 40 + 10;
    fireEvent.scroll(viewport);
    await waitFor(() => expect(screen.getByText("Transaction 40")).toBeInTheDocument());

    rerender(renderTable([{ id: "newest", label: "New transaction" }, ...ROWS]));

    await waitFor(() => expect(viewport.scrollTop).toBe(41 * 40 + 10));
    expect(screen.getByText("Transaction 40")).toBeInTheDocument();
  });

  it("keeps row counts and keyboard focus aligned when filtered rows change", async () => {
    const { rerender } = render(renderTable(ROWS.slice(0, 10)));
    const firstLink = screen.getByText("Transaction 0");
    firstLink.focus();
    fireEvent.keyDown(firstLink, { key: "ArrowDown" });
    const activeLink = screen.getByText("Transaction 1");
    expect(activeLink).toHaveFocus();

    const selectedRows = ROWS.slice(0, 10).filter((row) => row.id !== "tx-0");
    rerender(renderTable(selectedRows));

    await waitFor(() => expect(screen.getByText("Transaction 1")).toHaveAttribute("tabindex", "0"));
    expect(screen.getByRole("table", { name: "Transaction audit log" })).toHaveAttribute(
      "aria-rowcount",
      "10"
    );
  });

  it("supports keyboard selection and keeps checked state when virtual rows unmount", async () => {
    const onSelectionChange = jest.fn();
    const user = userEvent.setup();
    const selectedKeys = new Set(["tx-0"]);
    const { rerender } = render(
      renderTable(ROWS, 200, 1, 40, 3, selectedKeys, onSelectionChange)
    );

    expect(screen.getByRole("checkbox", { name: "Select Transaction 0" })).toBeChecked();
    screen.getByRole("checkbox", { name: "Select Transaction 1" }).focus();
    await user.keyboard(" ");
    expect(onSelectionChange).toHaveBeenCalledWith("tx-1", true);

    const viewport = screen.getByTestId("virtualized-table-viewport");
    viewport.scrollTop = 40 * 40;
    fireEvent.scroll(viewport);
    await waitFor(() => expect(screen.getByText("Transaction 40")).toBeInTheDocument());

    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Select Transaction 0" })).toBeChecked()
    );
    rerender(
      renderTable(ROWS, 200, 1, 40, 3, new Set(["tx-0", "tx-1"]), onSelectionChange)
    );
    expect(screen.getByRole("checkbox", { name: "Select Transaction 1" })).toBeChecked();
  });

  it("benchmarks full rendering against a virtualized 10,000-row table", () => {
    const startedFullRender = performance.now();
    const fullRender = render(
      <table aria-label="Full transaction audit log">
        <thead>
          <tr>
            <th>Select</th>
            <th>Date</th>
            <th>Type</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Transaction</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.id}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Select ${row.label}`}
                  checked={false}
                  readOnly
                />
              </td>
              <td>Oct 22, 2026</td>
              <td>Deposit</td>
              <td>1.00 USDC</td>
              <td>Success</td>
              <td><a href={`#${row.id}`}>{row.label}</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    );
    const fullRenderMs = performance.now() - startedFullRender;
    const fullNodeCount = fullRender.container.querySelectorAll("*").length;
    fullRender.unmount();

    const startedVirtualRender = performance.now();
    const virtualRender = renderTable(ROWS, 576, 5, 58, 5, new Set(), () => {});
    const renderedVirtualTable = render(virtualRender);
    const virtualRenderMs = performance.now() - startedVirtualRender;
    const virtualNodeCount = renderedVirtualTable.container.querySelectorAll("*").length;

    console.info(
      `[VirtualizedTable benchmark, ${ROWS.length} deterministic rows] ` +
        `full=${fullRenderMs.toFixed(1)}ms/${fullNodeCount} DOM nodes; ` +
        `virtual=${virtualRenderMs.toFixed(1)}ms/${virtualNodeCount} DOM nodes`
    );
    expect(virtualNodeCount).toBeLessThan(fullNodeCount);
    expect(screen.getByRole("table", { name: "Transaction audit log" })).toHaveAttribute(
      "aria-rowcount",
      "10001"
    );
  });
});
