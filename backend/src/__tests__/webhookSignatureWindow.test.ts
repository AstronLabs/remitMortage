// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

jest.mock("../services/db.js", () => ({ prisma: {} }));

import {
  DEFAULT_WEBHOOK_SIGNATURE_TOLERANCE_MS,
  MAX_WEBHOOK_SIGNATURE_TOLERANCE_MS,
  resolveWebhookSignatureToleranceMs,
  signPayload,
  verifyWebhookSignature,
} from "../services/webhook.js";

const SECRET = "shared-secret";
const BODY = JSON.stringify({ hello: "world" });
const NOW = Date.parse("2026-11-21T12:00:00.000Z");

function timestampAt(offsetMs: number): string {
  return String(NOW + offsetMs);
}

describe("webhook signature timestamp window (#991)", () => {
  it("accepts a valid signature inside the window", () => {
    const timestamp = timestampAt(-60_000);
    const signature = signPayload(SECRET, timestamp, BODY);

    const result = verifyWebhookSignature({
      secret: SECRET,
      timestamp,
      rawBody: BODY,
      signature,
      now: NOW,
    });

    expect(result.valid).toBe(true);
    expect(result.toleranceMs).toBe(DEFAULT_WEBHOOK_SIGNATURE_TOLERANCE_MS);
  });

  it("rejects an old request even with a valid signature", () => {
    const timestamp = timestampAt(-(DEFAULT_WEBHOOK_SIGNATURE_TOLERANCE_MS + 1));
    const signature = signPayload(SECRET, timestamp, BODY);

    const result = verifyWebhookSignature({
      secret: SECRET,
      timestamp,
      rawBody: BODY,
      signature,
      now: NOW,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("timestamp_outside_window");
  });

  it("rejects a future-dated request even with a valid signature", () => {
    const timestamp = timestampAt(DEFAULT_WEBHOOK_SIGNATURE_TOLERANCE_MS + 1);
    const signature = signPayload(SECRET, timestamp, BODY);

    const result = verifyWebhookSignature({
      secret: SECRET,
      timestamp,
      rawBody: BODY,
      signature,
      now: NOW,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("timestamp_outside_window");
  });

  it("rejects a tampered body", () => {
    const timestamp = timestampAt(-1_000);
    const signature = signPayload(SECRET, timestamp, BODY);

    const result = verifyWebhookSignature({
      secret: SECRET,
      timestamp,
      rawBody: JSON.stringify({ hello: "tampered" }),
      signature,
      now: NOW,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature_mismatch");
  });

  it("honours a custom, tightly-bounded tolerance window", () => {
    const timestamp = timestampAt(-5_000);
    const signature = signPayload(SECRET, timestamp, BODY);

    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp,
        rawBody: BODY,
        signature,
        toleranceMs: 1_000,
        now: NOW,
      }).valid
    ).toBe(false);

    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp,
        rawBody: BODY,
        signature,
        toleranceMs: 10_000,
        now: NOW,
      }).valid
    ).toBe(true);
  });

  it("rejects a missing/invalid timestamp", () => {
    const result = verifyWebhookSignature({
      secret: SECRET,
      timestamp: "not-a-number",
      rawBody: BODY,
      signature: "sha256=deadbeef",
      now: NOW,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid_timestamp");
  });

  it("caps an oversized configured tolerance at 24 hours", () => {
    expect(resolveWebhookSignatureToleranceMs(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_WEBHOOK_SIGNATURE_TOLERANCE_MS
    );
    expect(resolveWebhookSignatureToleranceMs(0)).toBe(DEFAULT_WEBHOOK_SIGNATURE_TOLERANCE_MS);
  });
});
