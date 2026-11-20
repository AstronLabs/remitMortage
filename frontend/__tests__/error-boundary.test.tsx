// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ErrorBoundary from "../src/components/ErrorBoundary";
import { anonymizeRoute, buildReport, generateErrorId, scrubText } from "../src/lib/error-report";

const mockCaptureException = jest.fn((..._args: unknown[]) => "evt-123");
const mockCaptureFeedback = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  captureException: (...a: unknown[]) => mockCaptureException(...a),
  captureFeedback: (...a: unknown[]) => mockCaptureFeedback(...a),
}));
jest.mock("next/navigation", () => ({ usePathname: () => "/repay/12345?email=a@b.co" }));

const G = "G" + "A".repeat(55);
const S = "S" + "B".repeat(55);

let shouldThrow = true;
function Bomb() {
  if (shouldThrow) throw new Error(`failed for user@example.com wallet ${G}`);
  return <p>All good</p>;
}

let consoleError: jest.SpyInstance;
beforeEach(() => {
  shouldThrow = true;
  mockCaptureException.mockClear();
  mockCaptureFeedback.mockClear();
  consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => consoleError.mockRestore());

describe("error boundary", () => {
  it("shows the fallback with an error ID and recovery actions on a render error", () => {
    render(<ErrorBoundary><Bomb /></ErrorBoundary>);
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
    expect(screen.getByTestId("fallback-error-id").textContent).toMatch(/^ERR-[0-9A-F]{12}$/);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Report a problem" })).toBeInTheDocument();
  });

  it("recovers when Try again re-renders successfully", () => {
    render(<ErrorBoundary><Bomb /></ErrorBoundary>);
    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("All good")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports a route crash once and keeps the surrounding navigation usable", () => {
    render(
      <React.StrictMode>
        <nav><a href="/dashboard">Dashboard</a></nav>
        <ErrorBoundary><Bomb /></ErrorBoundary>
      </React.StrictMode>,
    );

    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/dashboard");
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("All good")).toBeInTheDocument();
  });

  it("recovers when the resetKey changes (navigation)", () => {
    const { rerender } = render(<ErrorBoundary resetKey="/a"><Bomb /></ErrorBoundary>);
    shouldThrow = false;
    rerender(<ErrorBoundary resetKey="/b"><Bomb /></ErrorBoundary>);
    expect(screen.getByText("All good")).toBeInTheDocument();
  });

  it("captures a scrubbed exception tagged with the error ID and anonymized route", () => {
    render(<ErrorBoundary><Bomb /></ErrorBoundary>);
    const [captured, ctx] = mockCaptureException.mock.calls[0] as unknown as [Error, { tags: Record<string, string> }];
    expect(captured.message).not.toMatch(/user@example\.com|GAAAA/);
    expect(captured.message).toContain("[email]");
    expect(ctx.tags.error_id).toBe(screen.getByTestId("fallback-error-id").textContent);
    expect(ctx.tags.route).toBe("/repay/[id]");
  });

  it("sends a report with the error ID and no personal data", async () => {
    const user = userEvent.setup();
    render(<ErrorBoundary><Bomb /></ErrorBoundary>);
    const errorId = screen.getByTestId("fallback-error-id").textContent!;

    await user.click(screen.getByRole("button", { name: "Report a problem" }));
    expect(screen.getByRole("dialog", { name: "Report a problem" })).toBeInTheDocument();
    await user.type(
      screen.getByLabelText(/what were you doing/i),
      `It broke. Contact me at jane.doe@example.com or +1 (415) 555-0132, wallet ${G}, key ${S}`
    );
    await user.click(screen.getByRole("button", { name: "Send report" }));

    expect(mockCaptureFeedback).toHaveBeenCalledTimes(1);
    const payload = mockCaptureFeedback.mock.calls[0][0];
    expect(payload.message).toContain(errorId);
    expect(payload.associatedEventId).toBe("evt-123");
    expect(payload.tags).toEqual({ error_id: errorId, route: "/repay/[id]" });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/jane\.doe|example\.com|415|0132|GAAAA|SBBBB/);
    expect(screen.getByTestId("sent-error-id")).toHaveTextContent(errorId);
  });

  it("closes the dialog with Escape", async () => {
    const user = userEvent.setup();
    render(<ErrorBoundary><Bomb /></ErrorBoundary>);
    await user.click(screen.getByRole("button", { name: "Report a problem" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("scrubText", () => {
  it.each([
    ["email", "contact a.b+c@mail.example.org now", "[email]"],
    ["stellar address", `addr ${G}`, "[stellar-address]"],
    ["stellar secret", `key ${S}`, "[stellar-secret]"],
    ["jwt", "t eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk", "[token]"],
    ["bearer", "Authorization: Bearer abc123def456ghi789", "Bearer [token]"],
    ["tx hash", "tx " + "ab12".repeat(16), "[hash]"],
    ["uuid", "id 123e4567-e89b-12d3-a456-426614174000", "[uuid]"],
    ["card", "card 4111 1111 1111 1111", "[number]"],
    ["phone", "call +44 20 7946 0958", "[phone]"],
    ["ip", "from 203.0.113.42", "[ip]"],
    ["query secret", "https://x.io/p?token=abcdef&ok=1", "token=[redacted]"],
  ])("removes %s", (_n, input, marker) => {
    expect(scrubText(input)).toContain(marker);
  });

  it("leaves ordinary text alone", () => {
    expect(scrubText("The repayment table failed to render")).toBe("The repayment table failed to render");
  });
  it("handles empty input", () => {
    expect(scrubText(undefined)).toBe("");
  });
});

describe("report building", () => {
  it("anonymizes routes", () => {
    expect(anonymizeRoute("/explorer/tx/" + "0".repeat(64) + "?a=b#c")).toBe("/explorer/tx/[id]");
    expect(anonymizeRoute("/loans/42/schedule")).toBe("/loans/[id]/schedule");
    expect(anonymizeRoute("/")).toBe("/");
  });

  it("generates distinct, well-formed error IDs", () => {
    const ids = new Set(Array.from({ length: 50 }, generateErrorId));
    expect(ids.size).toBe(50);
    ids.forEach((id) => expect(id).toMatch(/^ERR-[0-9A-F]{12}$/));
  });

  it("only attaches coarse context", () => {
    const r = buildReport({ errorId: "ERR-1", pathname: "/x?y=1", description: "hi", error: new Error("boom") });
    expect(Object.keys(r.context).sort()).toEqual(["browser", "locale", "online", "timestamp", "viewport"]);
    expect(r.route).toBe("/x");
  });
});
