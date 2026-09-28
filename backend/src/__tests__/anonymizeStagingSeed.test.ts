// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Tests for the fail-closed PII leak gate (issue #757):
 * the refresh must not load data when anonymized output still contains
 * real PII shapes or verbatim source values.
 */

import { anonymizeRow, assertNoPiiLeak, scanBatchForPiiLeak } from "../../scripts/anonymize-staging-seed.js";
import { randomBytes } from "node:crypto";

const salt = randomBytes(32);

describe("PII leak gate", () => {
  it("passes clean anonymized output", () => {
    const src = [{ id: "1", email: "alice@real.com", phone: "+12025550100" }];
    const anon = [anonymizeRow("notificationPreference", src[0] as never, salt) as never];
    expect(scanBatchForPiiLeak("notificationPreference", src as never[], anon as never[])).toHaveLength(0);
    expect(() => assertNoPiiLeak("notificationPreference", src as never[], anon as never[])).not.toThrow();
  });

  it("fails closed when a raw source value survives verbatim", () => {
    const src = [{ id: "1", email: "alice@real.com" }];
    const anon = [{ id: "1", email: "alice@real.com" }];
    expect(scanBatchForPiiLeak("notificationPreference", src as never[], anon as never[]).length).toBeGreaterThan(0);
    expect(() => assertNoPiiLeak("notificationPreference", src as never[], anon as never[])).toThrow(/FAIL-CLOSED/);
  });

  it("fails closed on SSN-shaped output even in unmapped fields", () => {
    const src = [{ id: "1", notes: "x" }];
    const anon = [{ id: "1", notes: "SSN 123-45-6789 on file" }];
    expect(() => assertNoPiiLeak("workspace", src as never[], anon as never[])).toThrow(/FAIL-CLOSED/);
  });
});
