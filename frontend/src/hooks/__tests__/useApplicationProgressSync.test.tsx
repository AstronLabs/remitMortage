// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Server-side save and resume for the multi-step application (issue #1110).
 *
 * `fetch` is replaced by a fake backend that keeps one save point per signed-in
 * wallet. Each rendered hook stands in for a separate browser session or
 * device: nothing is shared between them except that backend.
 */

import React from "react";
import { act, render, renderHook, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useApplicationProgressSync } from "../useApplicationProgressSync";
import ApplicationResumeBanner from "@/components/onboarding/ApplicationResumeBanner";
import type { SavedApplicationProgress } from "@/lib/applicationProgressApi";

const WALLET = "G" + "B".repeat(55);
const STEPS = ["Connect Wallet", "Verify History", "Set Goal", "Documents", "Submit Application"];

/** The fake backend: one save point per wallet, like the ApplicationProgress table. */
const server = new Map<string, SavedApplicationProgress>();
let signedInWallet: string | null = WALLET;

function jsonResponse(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  server.clear();
  signedInWallet = WALLET;
  global.fetch = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (!signedInWallet) return jsonResponse(401, { error: "unauthorized" });
    const method = init?.method ?? "GET";
    if (method === "PUT") {
      const saved = { ...JSON.parse(String(init?.body)), updatedAt: new Date().toISOString() };
      server.set(signedInWallet, saved);
      return jsonResponse(200, saved);
    }
    if (method === "DELETE") {
      server.delete(signedInWallet);
      return jsonResponse(204);
    }
    const saved = server.get(signedInWallet);
    return saved ? jsonResponse(200, saved) : jsonResponse(404, { error: "no_saved_progress" });
  }) as jest.Mock;
});

/** Renders the hook as a wizard would, with its own local step and form data. */
function renderSession(initial: { step?: number; data?: Record<string, unknown> } = {}) {
  const state = { step: initial.step ?? 1, data: initial.data ?? {} };
  const onResume = jest.fn((progress: SavedApplicationProgress) => {
    state.step = progress.step;
    state.data = progress.data;
  });
  const hook = renderHook(
    ({ step }: { step: number }) =>
      useApplicationProgressSync({
        address: WALLET,
        step,
        totalSteps: STEPS.length,
        getData: () => state.data,
        onResume,
      }),
    { initialProps: { step: state.step } }
  );
  const goToStep = (step: number, data: Record<string, unknown>) => {
    state.step = step;
    state.data = data;
    hook.rerender({ step });
  };
  return { ...hook, state, onResume, goToStep };
}

const FORM = { recipientAddress: "G" + "C".repeat(55), savingsTarget: 25_000, savingsDuration: 9 };

describe("useApplicationProgressSync", () => {
  it("persists progress to the backend as the applicant moves between steps", async () => {
    const session = renderSession();
    await waitFor(() => expect(session.result.current.status).toBe("synced"));

    session.goToStep(2, FORM);
    await waitFor(() => expect(server.get(WALLET)?.step).toBe(2));

    session.goToStep(3, { ...FORM, savingsTarget: 30_000 });
    await waitFor(() => expect(server.get(WALLET)?.step).toBe(3));
    expect(server.get(WALLET)).toMatchObject({
      totalSteps: 5,
      data: { ...FORM, savingsTarget: 30_000 },
    });
  });

  it("restores exactly the data and step after the session is closed", async () => {
    const first = renderSession();
    await waitFor(() => expect(first.result.current.status).toBe("synced"));
    first.goToStep(3, FORM);
    await waitFor(() => expect(server.get(WALLET)?.step).toBe(3));
    first.unmount();

    const returning = renderSession();
    await waitFor(() => expect(returning.result.current.status).toBe("resume-available"));
    expect(returning.result.current.savedProgress).toMatchObject({ step: 3, data: FORM });

    act(() => returning.result.current.resume());

    expect(returning.onResume).toHaveBeenCalledTimes(1);
    expect(returning.state).toEqual({ step: 3, data: FORM });
    expect(returning.result.current.status).toBe("synced");
  });

  it("resumes on a different device from progress saved on another", async () => {
    const laptop = renderSession();
    await waitFor(() => expect(laptop.result.current.status).toBe("synced"));
    laptop.goToStep(4, FORM);
    await waitFor(() => expect(server.get(WALLET)?.step).toBe(4));

    // The phone has never seen this application: empty local state at step 1.
    window.localStorage.clear();
    const phone = renderSession();
    await waitFor(() => expect(phone.result.current.status).toBe("resume-available"));

    // Loading on the new device must not overwrite the laptop's save point.
    expect(server.get(WALLET)?.step).toBe(4);

    act(() => phone.result.current.resume());
    expect(phone.state).toEqual({ step: 4, data: FORM });
  });

  it("asks the applicant to sign in when there is no session", async () => {
    signedInWallet = null;
    const session = renderSession();

    await waitFor(() => expect(session.result.current.status).toBe("sign-in-required"));
    session.goToStep(2, FORM);
    expect(server.size).toBe(0);
  });

  it("starting over replaces the old save point on the next step", async () => {
    server.set(WALLET, { step: 4, totalSteps: 5, data: FORM, updatedAt: new Date().toISOString() });
    const session = renderSession();
    await waitFor(() => expect(session.result.current.status).toBe("resume-available"));

    act(() => session.result.current.startOver());
    session.goToStep(2, { savingsTarget: 1000 });

    await waitFor(() => expect(server.get(WALLET)?.step).toBe(2));
    expect(session.onResume).not.toHaveBeenCalled();
  });

  it("clears the save point once the application is submitted", async () => {
    const session = renderSession();
    await waitFor(() => expect(session.result.current.status).toBe("synced"));
    session.goToStep(5, FORM);
    await waitFor(() => expect(server.has(WALLET)).toBe(true));

    await act(() => session.result.current.clear());

    expect(server.has(WALLET)).toBe(false);
  });
});

describe("ApplicationResumeBanner", () => {
  const progress: SavedApplicationProgress = {
    step: 3,
    totalSteps: 5,
    data: FORM,
    updatedAt: "2026-11-20T10:00:00.000Z",
  };

  it("shows the step reached and how far along the applicant is", () => {
    render(
      <ApplicationResumeBanner
        progress={progress}
        stepLabels={STEPS}
        onResume={jest.fn()}
        onStartOver={jest.fn()}
      />
    );

    expect(screen.getByText(/step 3 of 5 \(Set Goal\)/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Application progress" })).toHaveAttribute(
      "aria-valuenow",
      "40"
    );
    expect(screen.getByText("40% complete")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume at step 3" })).toBeInTheDocument();
  });

  it("wires the resume and start-over actions", () => {
    const onResume = jest.fn();
    const onStartOver = jest.fn();
    render(
      <ApplicationResumeBanner
        progress={progress}
        stepLabels={STEPS}
        onResume={onResume}
        onStartOver={onStartOver}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Resume at step 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onStartOver).toHaveBeenCalledTimes(1);
  });
});
