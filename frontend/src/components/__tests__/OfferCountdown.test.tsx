// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import OfferCountdown from "../OfferCountdown";

const START = new Date("2026-11-20T12:00:00Z");

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(START);
});

afterEach(() => {
  jest.useRealTimers();
});

function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

describe("OfferCountdown", () => {
  it("counts down live without a reload", () => {
    render(<OfferCountdown expiresAt={START.getTime() + 20 * 60_000} onAccept={jest.fn()} />);
    expect(screen.getByRole("timer")).toHaveTextContent("20:00");

    advance(1000);
    expect(screen.getByRole("timer")).toHaveTextContent("19:59");

    advance(59_000);
    expect(screen.getByRole("timer")).toHaveTextContent("19:00");
  });

  it("switches to the urgent style once below the threshold", () => {
    render(
      <OfferCountdown
        expiresAt={START.getTime() + 5 * 60_000 + 2000}
        urgentThresholdMs={5 * 60_000}
        onAccept={jest.fn()}
      />
    );
    const status = screen.getByTestId("offer-countdown-status");
    expect(status).toHaveAttribute("data-state", "active");

    advance(2000);
    expect(status).toHaveAttribute("data-state", "urgent");
    expect(screen.getByRole("timer")).toHaveAttribute("aria-live", "assertive");
  });

  it("marks the offer expired and disables acceptance at the deadline", () => {
    const onAccept = jest.fn();
    render(<OfferCountdown expiresAt={new Date(START.getTime() + 3000).toISOString()} onAccept={onAccept} />);

    const button = screen.getByRole("button", { name: "Accept offer" });
    fireEvent.click(button);
    expect(onAccept).toHaveBeenCalledTimes(1);

    advance(3000);

    expect(screen.getByTestId("offer-countdown-status")).toHaveAttribute("data-state", "expired");
    expect(screen.getByTestId("offer-countdown-status")).toHaveTextContent("Offer expired");
    const expiredButton = screen.getByRole("button", { name: "Offer expired" });
    expect(expiredButton).toBeDisabled();
    fireEvent.click(expiredButton);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("refuses acceptance if the deadline passed before the next render", () => {
    const onAccept = jest.fn();
    render(<OfferCountdown expiresAt={START.getTime() + 500} onAccept={onAccept} />);
    // Move the clock past the deadline without letting timers fire.
    jest.setSystemTime(START.getTime() + 1000);

    fireEvent.click(screen.getByRole("button", { name: "Accept offer" }));
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("renders as expired straight away for a past deadline", () => {
    render(<OfferCountdown expiresAt={START.getTime() - 1} onAccept={jest.fn()} />);
    expect(screen.getByRole("button", { name: "Offer expired" })).toBeDisabled();
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
  });
});
