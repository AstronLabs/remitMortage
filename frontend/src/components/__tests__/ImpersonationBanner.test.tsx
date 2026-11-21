// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import ImpersonationBanner, { formatSessionDuration } from "../ImpersonationBanner";
import { endImpersonation, startImpersonation } from "@/lib/impersonationApi";

const mockToastSuccess = jest.fn();
jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: jest.fn(),
  },
}));

const ADMIN = "GADMIN1111111111111111111111111111111111111111111111AAAA";
const TARGET = "GTARGET222222222222222222222222222222222222222222222BBBB";

const INACTIVE = {
  active: false,
  sessionId: null,
  adminAddress: null,
  targetAddress: null,
  startedAt: null,
  expiresAt: null,
};

let serverStatus: Record<string, unknown> = INACTIVE;
const calls: { url: string; method: string; body?: string }[] = [];

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

beforeEach(() => {
  serverStatus = INACTIVE;
  calls.length = 0;
  mockToastSuccess.mockReset();
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
    if (url.endsWith("/status")) return jsonResponse(serverStatus);
    if (url.endsWith("/start")) {
      // Mirrors the backend: start writes `admin_impersonation_started`.
      serverStatus = {
        active: true,
        sessionId: "sess-1",
        adminAddress: ADMIN,
        targetAddress: TARGET,
        startedAt: new Date(Date.now() - 125_000).toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      };
      return jsonResponse({ sessionId: "sess-1", targetWallet: TARGET, expiresAt: serverStatus.expiresAt });
    }
    if (url.endsWith("/end")) {
      // Mirrors the backend: end writes `admin_impersonation_ended` with durationMs.
      serverStatus = INACTIVE;
      return jsonResponse({ ended: true });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
});

describe("ImpersonationBanner", () => {
  it("renders nothing when no impersonation session is active", async () => {
    render(<ImpersonationBanner />);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/status"))).toBe(true));
    expect(screen.queryByTestId("impersonation-banner")).not.toBeInTheDocument();
  });

  it("appears as soon as impersonation starts, naming the admin and the user", async () => {
    render(<ImpersonationBanner />);
    await waitFor(() => expect(calls).toHaveLength(1));

    // No poll tick is needed: starting fires the change event the banner listens for.
    await act(async () => {
      await startImpersonation(TARGET, "support ticket");
    });

    const banner = await screen.findByTestId("impersonation-banner");
    expect(banner).toBeVisible();
    const identities = screen.getByTestId("impersonation-identities");
    expect(identities).toHaveTextContent("Admin GADMIN…AAAA is viewing as GTARGE…BBBB");
    expect(calls.find((c) => c.url.endsWith("/start"))).toMatchObject({ method: "POST" });
  });

  it("exits the view in one click and reports the session duration", async () => {
    serverStatus = {
      active: true,
      sessionId: "sess-1",
      adminAddress: ADMIN,
      targetAddress: TARGET,
      startedAt: new Date(Date.now() - 125_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    render(<ImpersonationBanner />);
    const exit = await screen.findByTestId("end-impersonation-button");

    fireEvent.click(exit);

    await waitFor(() => expect(screen.queryByTestId("impersonation-banner")).not.toBeInTheDocument());
    const end = calls.find((c) => c.url.endsWith("/end"));
    expect(end).toMatchObject({ method: "POST" });
    expect(JSON.parse(end!.body!)).toEqual({ sessionId: "sess-1" });
    expect(mockToastSuccess).toHaveBeenCalledWith(
      expect.stringMatching(/^Impersonation session ended after 2m 0[5-9]s\.$/)
    );
  });

  it("disappears in other components when the session ends elsewhere in the tab", async () => {
    serverStatus = {
      active: true,
      sessionId: "sess-2",
      adminAddress: ADMIN,
      targetAddress: TARGET,
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    render(<ImpersonationBanner />);
    await screen.findByTestId("impersonation-banner");

    await act(async () => {
      await endImpersonation("sess-2");
    });

    await waitFor(() => expect(screen.queryByTestId("impersonation-banner")).not.toBeInTheDocument());
  });
});

describe("formatSessionDuration", () => {
  it("formats minutes and hours", () => {
    expect(formatSessionDuration(65_000)).toBe("1m 05s");
    expect(formatSessionDuration(3_725_000)).toBe("1h 02m 05s");
    expect(formatSessionDuration(-5)).toBe("0m 00s");
  });
});
