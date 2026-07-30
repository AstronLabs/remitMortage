import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import GasFeeAdjuster from "../src/components/tx/GasFeeAdjuster";
import { INCLUSION_FEE_STROOPS } from "../src/lib/gas-fees";
import type { SimulationEstimate } from "../src/lib/soroban-client";

const ESTIMATE: SimulationEstimate = {
  minResourceFeeStroops: "50000",
  instructions: "1200000",
  readBytes: "3200",
  writeBytes: "512",
  readEntries: "4",
  writeEntries: "2",
};

const BASELINE = 50_000 + INCLUSION_FEE_STROOPS;

function renderPanel(props: Partial<React.ComponentProps<typeof GasFeeAdjuster>> = {}) {
  const onChange = jest.fn();
  render(
    <GasFeeAdjuster estimate={ESTIMATE} value={null} onChange={onChange} {...props} />
  );
  return { onChange };
}

function expand() {
  fireEvent.click(screen.getByRole("button", { name: /transaction fee/i }));
}

describe("GasFeeAdjuster", () => {
  it("is collapsed by default and shows the recommended fee", () => {
    renderPanel();

    const toggle = screen.getByRole("button", { name: /transaction fee/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(/50,100 stroops/)).toBeInTheDocument();
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });

  it("expands to reveal the presets and the slider", () => {
    renderPanel();
    expand();

    expect(screen.getByTestId("fee-tier-standard")).toBeInTheDocument();
    expect(screen.getByTestId("fee-tier-fast")).toBeInTheDocument();
    expect(screen.getByTestId("fee-tier-instant")).toBeInTheDocument();
    expect(screen.getByRole("slider")).toBeInTheDocument();
  });

  it("emits the preset fee when a tier is picked", () => {
    const { onChange } = renderPanel();
    expand();

    fireEvent.click(screen.getByTestId("fee-tier-instant"));
    expect(onChange).toHaveBeenCalledWith(BASELINE * 5);
  });

  it("emits the slider value when dragged", () => {
    const { onChange } = renderPanel();
    expand();

    fireEvent.change(screen.getByRole("slider"), { target: { value: "123456" } });
    expect(onChange).toHaveBeenCalledWith(123456);
  });

  it("clears the override when the custom input is emptied", () => {
    const { onChange } = renderPanel({ value: 90_000 });
    expand();

    fireEvent.change(screen.getByLabelText(/custom max fee/i), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("warns when the chosen fee cannot cover the simulated resource fee", () => {
    renderPanel({ value: 10 });
    expand();

    expect(screen.getByRole("alert")).toHaveTextContent(/below the simulated resource fee/i);
  });

  it("restores the recommendation from the reset action", () => {
    const { onChange } = renderPanel({ value: BASELINE * 2 });
    expand();

    fireEvent.click(screen.getByRole("button", { name: /use recommended/i }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("marks the estimate as cached when it came from session storage", () => {
    renderPanel({ fromCache: true });
    expand();

    expect(screen.getByText(/cached from this session/i)).toBeInTheDocument();
  });

  it("shows a simulating placeholder before the first estimate", () => {
    renderPanel({ estimate: null, loading: true });
    expect(screen.getByText(/simulating/i)).toBeInTheDocument();
  });
});
