import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import NotificationFrequencyControl from "../src/components/NotificationFrequencyControl";

describe("NotificationFrequencyControl", () => {
  it("renders all three frequency options with the current value selected", () => {
    render(
      <NotificationFrequencyControl
        label="Deposits & Down-Payment Progress"
        description="Escrow alerts"
        value="DAILY_DIGEST"
        onChange={jest.fn()}
      />
    );

    expect(screen.getByRole("radio", { name: "Immediate" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: "Daily Digest" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Weekly Digest" })).toHaveAttribute("aria-checked", "false");
  });

  it("calls onChange with the selected frequency when an option is clicked", () => {
    const onChange = jest.fn();
    render(
      <NotificationFrequencyControl
        label="Construction Milestones"
        description="Milestone alerts"
        value="IMMEDIATE"
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByRole("radio", { name: "Weekly Digest" }));
    expect(onChange).toHaveBeenCalledWith("WEEKLY_DIGEST");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  describe("the non-overridable security-alert exception", () => {
    it("renders a locked Immediate badge instead of selectable options", () => {
      render(
        <NotificationFrequencyControl
          label="Security Alerts"
          description="New-device logins"
          value="IMMEDIATE"
          onChange={jest.fn()}
          locked
          lockedReason="Security alerts always send immediately and can't be delayed."
        />
      );

      expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
      expect(screen.queryByRole("radio")).not.toBeInTheDocument();
      expect(screen.getByText("Immediate (locked)")).toBeInTheDocument();
    });

    it("explains why the category can't be changed directly in the UI, not just via a tooltip", () => {
      render(
        <NotificationFrequencyControl
          label="Security Alerts"
          description="New-device logins"
          value="IMMEDIATE"
          onChange={jest.fn()}
          locked
          lockedReason="Security alerts always send immediately and can't be delayed."
        />
      );

      expect(
        screen.getByText("Security alerts always send immediately and can't be delayed.")
      ).toBeInTheDocument();
    });

    it("marks the locked badge as disabled and non-interactive", () => {
      const onChange = jest.fn();
      render(
        <NotificationFrequencyControl
          label="Security Alerts"
          description="New-device logins"
          value="IMMEDIATE"
          onChange={onChange}
          locked
        />
      );

      const badge = screen.getByText("Immediate (locked)");
      expect(badge).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(badge);
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});
