// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { NotificationProvider } from "@/context/NotificationContext";
import { ToastContainer } from "@/components/Toast";
import { DEFAULT_UNDO_WINDOW_MS, useUndoableAction } from "../useUndoableAction";

jest.mock("@/context/WalletContext", () => ({
  useWallet: () => ({ publicKey: null, isConnected: false }),
}));

const commitMock = jest.fn();
const revertMock = jest.fn();

function Harness() {
  const { run } = useUndoableAction();
  return (
    <button
      type="button"
      onClick={() =>
        run({ title: "Removed from watchlist", message: "Undo?", commit: commitMock, revert: revertMock })
      }
    >
      Remove
    </button>
  );
}

function renderHarness() {
  return render(
    <NotificationProvider>
      <Harness />
      <ToastContainer />
    </NotificationProvider>
  );
}

beforeEach(() => {
  commitMock.mockClear();
  revertMock.mockClear();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("useUndoableAction", () => {
  it("commits the action once the undo window lapses", () => {
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    // Nothing is applied while the window is open.
    expect(commitMock).not.toHaveBeenCalled();
    expect(revertMock).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(DEFAULT_UNDO_WINDOW_MS);
    });

    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(revertMock).not.toHaveBeenCalled();
  });

  it("reverts instead of committing when Undo is used inside the window", () => {
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(revertMock).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(DEFAULT_UNDO_WINDOW_MS);
    });

    expect(commitMock).not.toHaveBeenCalled();
  });
});
