// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import RecoveryCodesManager from "../RecoveryCodesManager";

const fetchTwoFactorStatusMock = jest.fn();
const regenerateRecoveryCodesMock = jest.fn();

jest.mock("@/lib/twoFactorApi", () => ({
  fetchTwoFactorStatus: (...args: unknown[]) => fetchTwoFactorStatusMock(...args),
  regenerateRecoveryCodes: (...args: unknown[]) => regenerateRecoveryCodesMock(...args),
}));

const NEW_CODES = ["AAAAA-11111", "BBBBB-22222", "CCCCC-33333", "DDDDD-44444"];

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderWith(status: { enabled: boolean; remainingRecoveryCodes: number }) {
  fetchTwoFactorStatusMock.mockResolvedValue(status);
  render(<RecoveryCodesManager />);
  await flush();
}

async function startRegeneration(code = "123456") {
  fireEvent.click(screen.getByRole("button", { name: "Regenerate codes" }));
  fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: code } });
  fireEvent.click(screen.getByRole("button", { name: "Generate new codes" }));
  await flush();
}

beforeEach(() => {
  fetchTwoFactorStatusMock.mockReset();
  regenerateRecoveryCodesMock.mockReset().mockResolvedValue(NEW_CODES);
  Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } });
  (URL as any).createObjectURL = jest.fn(() => "blob:codes");
  (URL as any).revokeObjectURL = jest.fn();
});

describe("remaining count and low-count warning", () => {
  it("shows the remaining count and no warning when plenty remain", async () => {
    await renderWith({ enabled: true, remainingRecoveryCodes: 8 });
    expect(screen.getByTestId("recovery-remaining")).toHaveTextContent("8 recovery codes remaining");
    expect(screen.queryByTestId("recovery-low-warning")).toBeNull();
  });

  it("warns when the remaining count is low", async () => {
    await renderWith({ enabled: true, remainingRecoveryCodes: 2 });
    expect(screen.getByTestId("recovery-low-warning")).toHaveTextContent("Only 2 recovery codes are left");
  });

  it("warns at the threshold boundary but not just above it", async () => {
    await renderWith({ enabled: true, remainingRecoveryCodes: 3 });
    expect(screen.getByTestId("recovery-low-warning")).toBeInTheDocument();
  });

  it("shows a stronger warning when none are left", async () => {
    await renderWith({ enabled: true, remainingRecoveryCodes: 0 });
    expect(screen.getByTestId("recovery-low-warning")).toHaveTextContent("no recovery codes left");
  });

  it("does not show the codes themselves and handles disabled 2FA", async () => {
    await renderWith({ enabled: false, remainingRecoveryCodes: 0 });
    expect(screen.getByTestId("recovery-2fa-disabled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Regenerate codes" })).toBeNull();
    expect(screen.queryAllByTestId("recovery-code")).toHaveLength(0);
  });
});

describe("regenerate flow", () => {
  it("warns that existing codes are invalidated and requires an authenticator code", async () => {
    await renderWith({ enabled: true, remainingRecoveryCodes: 5 });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate codes" }));
    expect(screen.getByText(/invalidates all of your existing codes/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Generate new codes" }));
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a current authenticator code");
    expect(regenerateRecoveryCodesMock).not.toHaveBeenCalled();
  });

  it("shows the new codes in a dialog and updates the remaining count", async () => {
    await renderWith({ enabled: true, remainingRecoveryCodes: 2 });
    await startRegeneration();

    expect(regenerateRecoveryCodesMock).toHaveBeenCalledWith("123456");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByTestId("recovery-code").map((el) => el.textContent)).toEqual(NEW_CODES);
    expect(screen.getByTestId("recovery-remaining")).toHaveTextContent("4 recovery codes remaining");
    expect(screen.queryByTestId("recovery-low-warning")).toBeNull();
  });

  it("cannot be dismissed until the codes are copied or downloaded", async () => {
    await renderWith({ enabled: true, remainingRecoveryCodes: 5 });
    await startRegeneration();

    const done = screen.getByRole("button", { name: /saved my codes/ });
    expect(done).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy codes" }));
    await flush();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(NEW_CODES.join("\n"));
    expect(done).toBeEnabled();

    fetchTwoFactorStatusMock.mockResolvedValue({ enabled: true, remainingRecoveryCodes: 4 });
    fireEvent.click(done);
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryAllByTestId("recovery-code")).toHaveLength(0);
  });

  it("can be dismissed after downloading", async () => {
    await renderWith({ enabled: true, remainingRecoveryCodes: 5 });
    await startRegeneration();

    fireEvent.click(screen.getByRole("button", { name: "Download codes" }));
    expect((URL as any).createObjectURL).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /saved my codes/ })).toBeEnabled();
  });

  it("stays locked when copying fails", async () => {
    await renderWith({ enabled: true, remainingRecoveryCodes: 5 });
    await startRegeneration();
    (navigator.clipboard.writeText as jest.Mock).mockRejectedValueOnce(new Error("denied"));

    fireEvent.click(screen.getByRole("button", { name: "Copy codes" }));
    await flush();
    expect(screen.getByRole("button", { name: /saved my codes/ })).toBeDisabled();
  });

  it("surfaces a server error without showing a dialog", async () => {
    await renderWith({ enabled: true, remainingRecoveryCodes: 5 });
    regenerateRecoveryCodesMock.mockRejectedValueOnce(new Error("Invalid 2FA code"));
    await startRegeneration("000000");

    expect(screen.getByRole("alert")).toHaveTextContent("Invalid 2FA code");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
