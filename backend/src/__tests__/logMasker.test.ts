// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { maskSensitiveData } from "../middleware/logMasker.js";

describe("logMasker - maskSensitiveData", () => {
  it("masks password fields", () => {
    const result = maskSensitiveData({ password: "supersecret123", name: "Alice" });
    expect(result).toEqual({ password: "***", name: "Alice" });
  });

  it("masks token fields", () => {
    const result = maskSensitiveData({ accessToken: "abc123", refreshToken: "xyz789" });
    expect(result).toEqual({ accessToken: "***", refreshToken: "***" });
  });

  it("masks apiKey regardless of case", () => {
    const result = maskSensitiveData({ APIKEY: "key123", Api_Key: "key456" });
    expect(result).toEqual({ APIKEY: "***", Api_Key: "***" });
  });

  it("masks passport and national ID fields", () => {
    const result = maskSensitiveData({ passportNumber: "AB123456", nationalId: "123-45-6789" });
    expect(result).toEqual({ passportNumber: "***", nationalId: "***" });
  });

  it("masks private_key and mnemonic", () => {
    const result = maskSensitiveData({
      privateKey: "0xabc123",
      mnemonic: "abandon amount liar",
    });
    expect(result).toEqual({ privateKey: "***", mnemonic: "***" });
  });

  it("masks nested sensitive fields", () => {
    const result = maskSensitiveData({
      user: { name: "Bob", password: "hunter2" },
    });
    expect(result).toEqual({
      user: { name: "Bob", password: "***" },
    });
  });

  it("leaves non-sensitive fields unchanged", () => {
    const result = maskSensitiveData({
      name: "Charlie",
      email: "charlie@example.com",
      amount: "1000",
    });
    expect(result).toEqual({
      name: "Charlie",
      email: "charlie@example.com",
      amount: "1000",
    });
  });

  it("masks string values that look like tokens", () => {
    const result = maskSensitiveData({
      signature: "0xdeadbeefcafebabe",
    });
    expect(result).toEqual({ signature: "***" });
  });

  it("handles null and undefined gracefully", () => {
    expect(maskSensitiveData(null)).toBeNull();
    expect(maskSensitiveData(undefined)).toBeUndefined();
    expect(maskSensitiveData("string")).toBe("string");
  });

  it("masks arrays containing sensitive keys", () => {
    const result = maskSensitiveData([{ password: "secret" }, { name: "Alice" }]);
    expect(result).toEqual([{ password: "***" }, { name: "Alice" }]);
  });
});
