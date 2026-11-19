// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import NotificationDrawer from "../NotificationDrawer";

const mockMarkRead = jest.fn();
const mockMarkAllRead = jest.fn();
const mockClearHistory = jest.fn();
const mockClosePanel = jest.fn();
const mockRemoveNotification = jest.fn();
const mockRestoreNotifications = jest.fn();
const mockNotify = jest.fn();
const mockDismiss = jest.fn();

// NotificationContext appends new records to the end of the array (oldest
// first); NotificationDrawer reverses this for newest-first display.
const mockHistory = [
  {
    id: "notif-2",
    variant: "success" as const,
    title: "Loan Approved",
    message: "Mortgage disbursement approved for 50,000 USDC.",
    duration: 5000,
    read: true,
    createdAt: Date.now() - 3600000, // 1 hour ago
  },
  {
    id: "notif-1",
    variant: "info" as const,
    title: "Escrow Deposit Received",
    message: "Deposited 500 USDC to escrow contract.",
    duration: 5000,
    read: false,
    createdAt: Date.now() - 60000, // 1 min ago
  },
];

jest.mock("@/context/NotificationContext", () => ({
  useNotifications: () => ({
    notificationHistory: mockHistory,
    unreadCount: 1,
    isPanelOpen: true,
    closePanel: mockClosePanel,
    clearHistory: mockClearHistory,
    markRead: mockMarkRead,
    markAllRead: mockMarkAllRead,
    removeNotification: mockRemoveNotification,
    restoreNotifications: mockRestoreNotifications,
    notify: mockNotify,
    dismiss: mockDismiss,
  }),
}));

describe("NotificationDrawer Component", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders notification inbox drawer when panel is open", () => {
    render(<NotificationDrawer />);

    expect(screen.getByTestId("notification-center-drawer")).toBeInTheDocument();
    expect(screen.getByText("Notification Inbox")).toBeInTheDocument();
    expect(screen.getByText("Escrow Deposit Received")).toBeInTheDocument();
    expect(screen.getByText("Loan Approved")).toBeInTheDocument();
  });

  it("displays notifications in reverse-chronological order (newest first)", () => {
    render(<NotificationDrawer />);

    const articles = screen.getAllByRole("article");
    expect(articles).toHaveLength(2);
    // First item should be notif-1 (newest, 1 min ago)
    expect(articles[0]).toHaveAttribute("data-testid", "notification-item-notif-1");
    // Second item should be notif-2 (older, 1 hr ago)
    expect(articles[1]).toHaveAttribute("data-testid", "notification-item-notif-2");
  });

  it("renders distinct unread and read indicators", () => {
    render(<NotificationDrawer />);

    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByTestId("mark-read-btn-notif-1")).toBeInTheDocument();
  });

  it("calls markRead when Mark read button is clicked on an unread notification", () => {
    render(<NotificationDrawer />);

    fireEvent.click(screen.getByTestId("mark-read-btn-notif-1"));
    expect(mockMarkRead).toHaveBeenCalledWith("notif-1");
  });

  it("calls markAllRead when Read all button is clicked", () => {
    render(<NotificationDrawer />);

    fireEvent.click(screen.getByTestId("mark-all-read-btn"));
    expect(mockMarkAllRead).toHaveBeenCalledTimes(1);
  });

  it("dismisses a notification and offers an undo window", () => {
    render(<NotificationDrawer />);

    fireEvent.click(screen.getByTestId("dismiss-btn-notif-1"));

    expect(mockRemoveNotification).toHaveBeenCalledWith("notif-1");
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        transient: true,
        action: expect.objectContaining({ label: "Undo" }),
      })
    );
  });

  it("restores a dismissed notification when Undo is used inside the window", () => {
    render(<NotificationDrawer />);

    fireEvent.click(screen.getByTestId("dismiss-btn-notif-1"));

    const undoToast = mockNotify.mock.calls[mockNotify.mock.calls.length - 1][0];
    act(() => {
      undoToast.action.onAction();
    });

    expect(mockRestoreNotifications).toHaveBeenCalledWith([mockHistory[1]]);
  });

  it("clears the notification list behind an undo window and restores it on undo", () => {
    render(<NotificationDrawer />);

    fireEvent.click(screen.getByLabelText("Clear notification list"));
    expect(mockClearHistory).toHaveBeenCalledTimes(1);

    const undoToast = mockNotify.mock.calls[mockNotify.mock.calls.length - 1][0];
    act(() => {
      undoToast.action.onAction();
    });

    expect(mockRestoreNotifications).toHaveBeenCalledWith(mockHistory);
  });
});
