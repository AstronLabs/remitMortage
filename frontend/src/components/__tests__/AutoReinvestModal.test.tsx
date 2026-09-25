// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AutoReinvestModal } from "../AutoReinvestModal";

const LOCAL_STORAGE_KEY = "investor_auto_reinvest";

function TestToggle() {
  const [autoReinvest, setAutoReinvest] = React.useState(false);
  const [showModal, setShowModal] = React.useState(false);

  function handleToggle() {
    if (!autoReinvest) {
      setShowModal(true);
    } else {
      setAutoReinvest(false);
      try { localStorage.setItem(LOCAL_STORAGE_KEY, "false"); } catch {}
    }
  }

  function confirm() {
    setAutoReinvest(true);
    try { localStorage.setItem(LOCAL_STORAGE_KEY, "true"); } catch {}
    setShowModal(false);
  }

  return (
    <div>
      <button
        onClick={handleToggle}
        aria-pressed={autoReinvest}
        aria-label="Toggle auto-reinvest yield"
        data-testid="toggle"
      >
        {autoReinvest ? "On" : "Off"}
      </button>
      {autoReinvest && <span data-testid="active-indicator">Auto-Reinvesting</span>}
      <AutoReinvestModal isOpen={showModal} onConfirm={confirm} onCancel={() => setShowModal(false)} />
    </div>
  );
}

describe("AutoReinvestModal", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders nothing when closed", () => {
    const { queryByRole } = render(
      <AutoReinvestModal isOpen={false} onConfirm={jest.fn()} onCancel={jest.fn()} />
    );
    expect(queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders the modal when open", () => {
    render(<AutoReinvestModal isOpen onConfirm={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Enable Auto-Reinvest")).toBeInTheDocument();
  });

  it("calls onCancel when the Cancel button is clicked", () => {
    const onCancel = jest.fn();
    render(<AutoReinvestModal isOpen onConfirm={jest.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onConfirm when the Enable button is clicked", () => {
    const onConfirm = jest.fn();
    render(<AutoReinvestModal isOpen onConfirm={onConfirm} onCancel={jest.fn()} />);
    fireEvent.click(screen.getByText("Enable Auto-Reinvest"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when the backdrop is clicked", () => {
    const onCancel = jest.fn();
    render(<AutoReinvestModal isOpen onConfirm={jest.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("dialog").previousElementSibling!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("Auto-reinvest toggle state persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("enabling auto-reinvest requires passing through the confirmation modal", () => {
    render(<TestToggle />);

    // Toggle starts off — no modal, no active indicator
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("active-indicator")).not.toBeInTheDocument();

    // Click the toggle — modal should appear, NOT immediately activate
    fireEvent.click(screen.getByTestId("toggle"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByTestId("active-indicator")).not.toBeInTheDocument();
  });

  it("cancelling the modal keeps auto-reinvest off", () => {
    render(<TestToggle />);

    fireEvent.click(screen.getByTestId("toggle"));
    fireEvent.click(screen.getByText("Cancel"));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("toggle")).toHaveAttribute("aria-pressed", "false");
    expect(localStorage.getItem(LOCAL_STORAGE_KEY)).toBeNull();
  });

  it("confirming the modal enables auto-reinvest and persists to localStorage", () => {
    render(<TestToggle />);

    fireEvent.click(screen.getByTestId("toggle"));
    fireEvent.click(screen.getByText("Enable Auto-Reinvest"));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("toggle")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("active-indicator")).toBeInTheDocument();
    expect(localStorage.getItem(LOCAL_STORAGE_KEY)).toBe("true");
  });

  it("disabling auto-reinvest does not show a modal and persists the off state", () => {
    render(<TestToggle />);

    // Enable first
    fireEvent.click(screen.getByTestId("toggle"));
    fireEvent.click(screen.getByText("Enable Auto-Reinvest"));

    // Now disable directly — no modal
    fireEvent.click(screen.getByTestId("toggle"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("toggle")).toHaveAttribute("aria-pressed", "false");
    expect(localStorage.getItem(LOCAL_STORAGE_KEY)).toBe("false");
  });
});
