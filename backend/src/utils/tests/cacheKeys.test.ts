// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  analyticsKey,
  remittanceKey,
  verificationKey,
  idempotencyKey,
} from "../cacheKeys.js";

describe("cacheKeys", () => {
  describe("analyticsKey", () => {
    it("returns the expected format", () => {
      expect(analyticsKey("/api/analytics/overview")).toBe(
        "analytics:/api/analytics/overview",
      );
    });
  });

  describe("remittanceKey", () => {
    it("returns the expected format", () => {
      expect(remittanceKey("GB123…abc")).toBe("remittance:GB123…abc");
    });
  });

  describe("verificationKey", () => {
    it("returns the expected format", () => {
      expect(verificationKey("GB456…def")).toBe("verification:GB456…def");
    });
  });

  describe("idempotencyKey", () => {
    it("returns the expected format", () => {
      expect(idempotencyKey("uuid-1234")).toBe("idempotency:uuid-1234");
    });
  });
});
