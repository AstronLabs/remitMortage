// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import IdleSessionModal from "../IdleSessionModal";
import { IdleSessionProvider, useIdleSession } from "@/context/IdleSessionContext";

// Mock WalletContext and ToastContext
const mockDisconnectAll = jest.fn();
const mockToast = jest.fn();

jest.mock("@/context/WalletContext", () => ({
  useWallet: () => ({
    isConnected: true,
    disconnectAll: mockDisconnectAll,
  }),
}));

jest.mock("@/context/ToastContext", () => ({
  useToast: () => ({
    toast: mockToast,
  }),
}));

describe("IdleSessionModal Component", () => {
  it("does not render when isOpen is false", () => {
    render(
      <IdleSessionModal
        isOpen={false}
        remainingSeconds={60}
        onExtendSession={jest.fn()}
        onLogoutNow={jest.fn()}
      />
    );
    expect(screen.queryByTestId("idle-warning-modal")).not.toBeInTheDocument();
  });

  it("renders countdown time and warning elements when open", () => {
    render(
      <IdleSessionModal
        isOpen={true}
        remainingSeconds={45}
        onExtendSession={jest.fn()}
        onLogoutNow={jest.fn()}
      />
    );

    expect(screen.getByTestId("idle-warning-modal")).toBeInTheDocument();
    expect(screen.getByTestId("idle-countdown")).toHaveTextContent("00:45");
    expect(screen.getByText(/Are you still there\?/i)).toBeInTheDocument();
  });

  it("triggers onExtendSession when Stay Logged In button is clicked", () => {
    const handleExtend = jest.fn();
    render(
      <IdleSessionModal
        isOpen={true}
        remainingSeconds={30}
        onExtendSession={handleExtend}
        onLogoutNow={jest.fn()}
      />
    );

    fireEvent.click(screen.getByTestId("extend-session-btn"));
    expect(handleExtend).toHaveBeenCalledTimes(1);
  });

  it("triggers onLogoutNow when Log Out button is clicked", () => {
    const handleLogout = jest.fn();
    render(
      <IdleSessionModal
        isOpen={true}
        remainingSeconds={30}
        onExtendSession={jest.fn()}
        onLogoutNow={handleLogout}
      />
    );

    fireEvent.click(screen.getByTestId("logout-now-btn"));
    expect(handleLogout).toHaveBeenCalledTimes(1);
  });
});

function TestConsumer() {
  const { isWarningOpen, remainingSeconds, extendSession, logoutSession } = useIdleSession();
  return (
    <div>
      <span data-testid="warning-status">{isWarningOpen ? "OPEN" : "CLOSED"}</span>
      <span data-testid="seconds-left">{remainingSeconds}</span>
      <button data-testid="manual-extend" onClick={extendSession}>
        Extend
      </button>
      <button data-testid="manual-logout" onClick={logoutSession}>
        Logout
      </button>
    </div>
  );
}

describe("IdleSessionProvider Logic", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it("triggers warning modal when warning threshold is reached", () => {
    render(
      <IdleSessionProvider timeoutMs={10000} warningDurationMs={3000}>
        <TestConsumer />
      </IdleSessionProvider>
    );

    expect(screen.getByTestId("warning-status")).toHaveTextContent("CLOSED");

    // Advance 7 seconds (timeout 10s - warning 3s = threshold at 7s)
    act(() => {
      jest.advanceTimersByTime(7100);
    });

    expect(screen.getByTestId("warning-status")).toHaveTextContent("OPEN");
    expect(screen.getByTestId("idle-warning-modal")).toBeInTheDocument();
  });

  it("automatically logs out and clears state when countdown hits 0", () => {
    render(
      <IdleSessionProvider timeoutMs={5000} warningDurationMs={2000}>
        <TestConsumer />
      </IdleSessionProvider>
    );

    // Advance to full 5 second timeout
    act(() => {
      jest.advanceTimersByTime(5100);
    });

    expect(mockDisconnectAll).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "warning",
        title: "Session Expired",
        message: expect.stringContaining("logged out automatically"),
      })
    );
  });

  it("resets idle timer when user activity occurs before warning threshold", () => {
    render(
      <IdleSessionProvider timeoutMs={10000} warningDurationMs={3000}>
        <TestConsumer />
      </IdleSessionProvider>
    );

    // Advance 5 seconds
    act(() => {
      jest.advanceTimersByTime(5000);
    });

    // Simulate user mouse movement
    act(() => {
      fireEvent.mouseMove(window);
    });

    // Advance another 5 seconds (total 10s elapsed, but reset happened at 5s)
    act(() => {
      jest.advanceTimersByTime(5000);
    });

    // Warning should still be closed because mouse movement reset lastActivity
    expect(screen.getByTestId("warning-status")).toHaveTextContent("CLOSED");
  });
});
