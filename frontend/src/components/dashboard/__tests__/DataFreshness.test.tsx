import { fireEvent, render, screen } from "@testing-library/react";
import DataFreshness from "../DataFreshness";

describe("DataFreshness", () => {
  it("renders a fresh timestamp", () => {
    render(<DataFreshness timestamp={new Date().toISOString()} staleAfterMs={60_000} />);
    expect(screen.getByText(/Last updated:/)).toBeInTheDocument();
    expect(screen.queryByText(/Stale data/)).not.toBeInTheDocument();
  });

  it("marks stale data and reports a failed refresh", () => {
    const onRefresh = jest.fn();
    render(
      <DataFreshness
        timestamp="2020-01-01T00:00:00.000Z"
        staleAfterMs={60_000}
        onRefresh={onRefresh}
        refreshError="network unavailable"
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/Stale data/);
    expect(screen.getByText(/Refresh failed: network unavailable/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("shows refresh progress and disables the control", () => {
    render(
      <DataFreshness
        timestamp={new Date().toISOString()}
        staleAfterMs={60_000}
        onRefresh={jest.fn()}
        refreshing
      />
    );
    expect(screen.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
  });
});
