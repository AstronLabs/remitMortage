// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { fireEvent, render, screen } from "@testing-library/react";
import DateRangePicker, { getPresetRange, validateDateRange } from "../DateRangePicker";

describe("DateRangePicker", () => {
  it("calculates local presets and validates order", () => {
    const now = new Date(2026, 5, 15, 12);
    expect(getPresetRange("7", now)).toEqual({ start: "2026-06-09", end: "2026-06-15" });
    expect(getPresetRange("ytd", now).start).toBe("2026-01-01");
    expect(validateDateRange({ start: "2026-06-16", end: "2026-06-15" })).toBe(false);
  });

  it("is keyboard-operable and reports invalid ranges", () => {
    const onChange = jest.fn();
    render(
      <DateRangePicker value={{ start: "2026-06-01", end: "2026-06-15" }} onChange={onChange} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
    expect(onChange).toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-06-20" } });
    expect(onChange).toHaveBeenCalledWith({ start: "2026-06-20", end: "2026-06-15" });
  });
});
