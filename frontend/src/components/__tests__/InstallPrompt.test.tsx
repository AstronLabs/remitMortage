// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { act, render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import InstallPrompt from "../InstallPrompt";
import {
  DEFAULT_INSTALL_PROMPT_DELAY_MS,
  INSTALL_PROMPT_DISMISSED_KEY,
  type BeforeInstallPromptEvent,
} from "@/hooks/useInstallPrompt";

/** Build a synthetic `beforeinstallprompt` event jsdom can dispatch. */
function createInstallEvent(outcome: "accepted" | "dismissed" = "accepted"): BeforeInstallPromptEvent {
  const event = new Event("beforeinstallprompt") as BeforeInstallPromptEvent;
  Object.assign(event, {
    prompt: jest.fn().mockResolvedValue(undefined),
    userChoice: Promise.resolve({ outcome, platform: "web" }),
  });
  return event;
}

beforeEach(() => {
  window.localStorage.clear();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

describe("InstallPrompt", () => {
  it("does not appear immediately, then shows after the delay", () => {
    render(<InstallPrompt />);

    act(() => {
      window.dispatchEvent(createInstallEvent());
    });

    // Right after the browser reports installability there is no prompt yet.
    expect(screen.queryByTestId("install-prompt")).not.toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(DEFAULT_INSTALL_PROMPT_DELAY_MS);
    });

    expect(screen.getByTestId("install-prompt")).toBeInTheDocument();
  });

  it("stays hidden when the browser never reports installability", () => {
    render(<InstallPrompt />);

    act(() => {
      jest.advanceTimersByTime(DEFAULT_INSTALL_PROMPT_DELAY_MS);
    });

    expect(screen.queryByTestId("install-prompt")).not.toBeInTheDocument();
  });

  it("triggers the native install flow when accepted", async () => {
    render(<InstallPrompt />);
    const event = createInstallEvent("accepted");

    act(() => {
      window.dispatchEvent(event);
    });
    act(() => {
      jest.advanceTimersByTime(DEFAULT_INSTALL_PROMPT_DELAY_MS);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("install-prompt-accept"));
    });

    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("install-prompt")).not.toBeInTheDocument();
  });

  it("dismisses the prompt and remembers the dismissal", () => {
    render(<InstallPrompt />);

    act(() => {
      window.dispatchEvent(createInstallEvent());
    });
    act(() => {
      jest.advanceTimersByTime(DEFAULT_INSTALL_PROMPT_DELAY_MS);
    });

    fireEvent.click(screen.getByTestId("install-prompt-dismiss"));

    expect(screen.queryByTestId("install-prompt")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(INSTALL_PROMPT_DISMISSED_KEY)).toBe("1");
  });

  it("never shows again after a dismissal", () => {
    window.localStorage.setItem(INSTALL_PROMPT_DISMISSED_KEY, "1");

    render(<InstallPrompt />);

    act(() => {
      window.dispatchEvent(createInstallEvent());
    });
    act(() => {
      jest.advanceTimersByTime(DEFAULT_INSTALL_PROMPT_DELAY_MS);
    });

    expect(screen.queryByTestId("install-prompt")).not.toBeInTheDocument();
  });
});
