// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  classifyWalletError,
  describeNetworkMismatch,
  getExpectedNetwork,
  isNetworkMismatch,
  isUserRejection,
  WALLET_ERROR_MESSAGES,
} from "../wallet-errors";

describe("classifyWalletError", () => {
  it("detects Freighter rejection messages", () => {
    const cases = [
      new Error("User declined access"),
      new Error("User rejected the transaction"),
      "The request was declined",
      { message: "Operation cancelled by user" },
    ];

    for (const input of cases) {
      const result = classifyWalletError(input);
      expect(result.kind).toBe("rejected");
      expect(result.message).toBe(WALLET_ERROR_MESSAGES.rejected);
      expect(result.recoverable).toBe(false);
    }
  });

  it("detects rejection codes from provider-style payloads", () => {
    expect(classifyWalletError({ code: 4001, message: "" }).kind).toBe("rejected");
    expect(classifyWalletError({ error: { code: -4 } }).kind).toBe("rejected");
  });

  it("detects network mismatch failures", () => {
    const result = classifyWalletError(new Error("Network mismatch: expected TESTNET"));
    expect(result.kind).toBe("network_mismatch");
    expect(result.message).toBe(WALLET_ERROR_MESSAGES.network_mismatch);
  });

  it("detects a missing extension", () => {
    expect(classifyWalletError(new Error("Freighter is not available")).kind).toBe(
      "not_installed"
    );
    expect(
      classifyWalletError(new Error("Freighter signing API is unavailable")).kind
    ).toBe("not_installed");
  });

  it("detects a locked wallet as recoverable", () => {
    const result = classifyWalletError(new Error("Wallet is locked"));
    expect(result.kind).toBe("locked");
    expect(result.recoverable).toBe(true);
  });

  it("detects revoked access as a disconnect", () => {
    expect(classifyWalletError(new Error("Not allowed to access")).kind).toBe(
      "disconnected"
    );
    expect(
      classifyWalletError(new Error("Could not get public key from Freighter")).kind
    ).toBe("disconnected");
  });

  it("keeps the original message as detail for unknown failures", () => {
    const result = classifyWalletError(new Error("some novel wallet failure"));
    expect(result.kind).toBe("unknown");
    expect(result.detail).toBe("some novel wallet failure");
    expect(result.recoverable).toBe(true);
  });

  it("tolerates non-error values", () => {
    expect(classifyWalletError(undefined).kind).toBe("unknown");
    expect(classifyWalletError(null).detail).toBeUndefined();
  });
});

describe("isUserRejection", () => {
  it("is true only for rejections", () => {
    expect(isUserRejection(new Error("User declined access"))).toBe(true);
    expect(isUserRejection(new Error("Wallet is locked"))).toBe(false);
  });
});

describe("network helpers", () => {
  it("defaults to TESTNET", () => {
    expect(getExpectedNetwork()).toBe("TESTNET");
  });

  it("flags a wallet on another network", () => {
    expect(isNetworkMismatch("PUBLIC")).toBe(true);
    expect(isNetworkMismatch("public")).toBe(true);
    expect(isNetworkMismatch("TESTNET")).toBe(false);
    expect(isNetworkMismatch("testnet")).toBe(false);
  });

  it("does not flag an unknown network", () => {
    expect(isNetworkMismatch(null)).toBe(false);
    expect(isNetworkMismatch(undefined)).toBe(false);
  });

  it("names both networks in the mismatch copy", () => {
    const copy = describeNetworkMismatch("PUBLIC");
    expect(copy).toContain("PUBLIC");
    expect(copy).toContain("TESTNET");
  });
});
