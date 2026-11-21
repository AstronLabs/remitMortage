import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import NotificationChannelMatrix from "../src/components/NotificationChannelMatrix";
import { resolveEventChannels, toggleEventChannel, type EventChannels } from "../src/lib/notificationChannels";

function Harness({ initial, onChange }: { initial: EventChannels; onChange?: (v: EventChannels) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <NotificationChannelMatrix
      value={value}
      onToggle={(type, channel) => {
        const next = toggleEventChannel(value, type, channel);
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

describe("NotificationChannelMatrix", () => {
  it("shows each event type's channels seeded from the global setting", () => {
    render(<Harness initial={resolveEventChannels({ emailAlerts: true, smsAlerts: false })} />);
    expect(screen.getByRole("checkbox", { name: "Missed Payment Warning via Email" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Missed Payment Warning via SMS" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Governance Proposals via Email" })).toBeChecked();
  });

  it("lets one event type use SMS and email while another stays email-only", () => {
    const onChange = jest.fn();
    render(<Harness initial={resolveEventChannels({ emailAlerts: true })} onChange={onChange} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Missed Payment Warning via SMS" }));

    expect(screen.getByRole("checkbox", { name: "Missed Payment Warning via Email" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Missed Payment Warning via SMS" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Governance Proposals via SMS" })).not.toBeChecked();
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ paymentMissed: ["email", "sms"], governanceAlerts: ["email"] })
    );
    expect(screen.getByText("Delivered by Email + SMS")).toBeInTheDocument();
  });

  it("explains when an event type has no channels", () => {
    render(<Harness initial={resolveEventChannels({ emailAlerts: true })} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Loan Status & Approval via Email" }));
    expect(screen.getByText(/won't be notified of this event/)).toBeInTheDocument();
  });
});
