// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import KeyboardShortcutsModal from "../KeyboardShortcutsModal";
import { KeyboardShortcutsProvider, useKeyboardShortcuts } from "@/context/KeyboardShortcutsContext";

const mockPush = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

describe("KeyboardShortcutsModal Component", () => {
  it("does not render when isOpen is false", () => {
    render(<KeyboardShortcutsModal isOpen={false} onClose={jest.fn()} />);
    expect(screen.queryByText("Keyboard Shortcuts")).not.toBeInTheDocument();
  });

  it("renders cheat-sheet overlay with shortcut items when isOpen is true", () => {
    render(<KeyboardShortcutsModal isOpen={true} onClose={jest.fn()} />);
    expect(screen.getByText("Keyboard Shortcuts")).toBeInTheDocument();
    expect(screen.getByText("Go to Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Go to Admin Panel")).toBeInTheDocument();
    expect(screen.getByText("Open Comparison / Application Tool")).toBeInTheDocument();
  });

  it("calls onClose when Close button or Escape is pressed", () => {
    const handleClose = jest.fn();
    render(<KeyboardShortcutsModal isOpen={true} onClose={handleClose} />);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(handleClose).toHaveBeenCalled();
  });
});

function TestComponent() {
  const { isCheatSheetOpen, toggleCheatSheet, isPrefixActive } = useKeyboardShortcuts();
  return (
    <div>
      <span data-testid="modal-status">{isCheatSheetOpen ? "OPEN" : "CLOSED"}</span>
      <span data-testid="prefix-status">{isPrefixActive ? "ACTIVE" : "INACTIVE"}</span>
      <button data-testid="toggle-btn" onClick={toggleCheatSheet}>
        Toggle
      </button>
      <input data-testid="test-input" type="text" />
      <textarea data-testid="test-textarea" />
    </div>
  );
}

describe("KeyboardShortcutsProvider Logic", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("toggles cheat sheet overlay on '?' key press", () => {
    render(
      <KeyboardShortcutsProvider>
        <TestComponent />
      </KeyboardShortcutsProvider>
    );

    expect(screen.getByTestId("modal-status")).toHaveTextContent("CLOSED");

    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByTestId("modal-status")).toHaveTextContent("OPEN");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("modal-status")).toHaveTextContent("CLOSED");
  });

  it("ignores shortcut key events when typing inside text inputs or textareas", () => {
    render(
      <KeyboardShortcutsProvider>
        <TestComponent />
      </KeyboardShortcutsProvider>
    );

    const input = screen.getByTestId("test-input");
    input.focus();

    fireEvent.keyDown(input, { key: "?" });
    expect(screen.getByTestId("modal-status")).toHaveTextContent("CLOSED");

    fireEvent.keyDown(input, { key: "c" });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("navigates on single-key action shortcut ('c')", () => {
    render(
      <KeyboardShortcutsProvider>
        <TestComponent />
      </KeyboardShortcutsProvider>
    );

    fireEvent.keyDown(window, { key: "c" });
    expect(mockPush).toHaveBeenCalledWith("/application");
  });

  it("handles 'g' chord prefix sequence correctly ('g' -> 'd' to navigate to /dashboard)", () => {
    render(
      <KeyboardShortcutsProvider>
        <TestComponent />
      </KeyboardShortcutsProvider>
    );

    // Press 'g'
    fireEvent.keyDown(window, { key: "g" });
    expect(screen.getByTestId("prefix-status")).toHaveTextContent("ACTIVE");

    // Press 'd'
    fireEvent.keyDown(window, { key: "d" });
    expect(mockPush).toHaveBeenCalledWith("/dashboard");
    expect(screen.getByTestId("prefix-status")).toHaveTextContent("INACTIVE");
  });

  it("handles 'g' chord prefix sequence ('g' -> 'a' to navigate to /admin)", () => {
    render(
      <KeyboardShortcutsProvider>
        <TestComponent />
      </KeyboardShortcutsProvider>
    );

    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "a" });
    expect(mockPush).toHaveBeenCalledWith("/admin");
  });
});
