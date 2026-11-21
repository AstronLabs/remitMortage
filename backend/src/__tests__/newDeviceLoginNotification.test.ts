// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  createInAppNotification,
  getNotificationPreference,
} from "../services/db.js";
import { getCommunicationPreferences } from "../services/communicationPreferences.js";
import { sendEmail } from "../services/email.js";
import {
  deviceFingerprintFromHeaders,
  hashDeviceFingerprint,
  registerLoginDevice,
} from "../services/loginDeviceNotification.js";
import { clearUserSessions, isKnownDevice } from "../services/userSessions.js";

jest.mock("../services/db.js", () => ({
  getNotificationPreference: jest.fn(),
  createInAppNotification: jest.fn(),
}));

jest.mock("../services/communicationPreferences.js", () => ({
  getCommunicationPreferences: jest.fn(),
}));

jest.mock("../services/email.js", () => ({
  sendEmail: jest.fn(),
  getBrandedHtml: jest.fn((_title: string, body: string) => body),
}));

jest.mock("../services/audit.js", () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

const WALLET = "GNEWDEVICEWALLET000000000000000000000000000000000000001";

function defaultMatrix(emailEnabled = true) {
  return {
    SECURITY: {
      EMAIL: { enabled: emailEnabled, consentTimestamp: null, consentSource: null },
      SMS: { enabled: false, consentTimestamp: null, consentSource: null },
      PUSH: { enabled: true, consentTimestamp: null, consentSource: null },
    },
  } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  clearUserSessions();
  (getNotificationPreference as jest.Mock).mockResolvedValue({
    email: "user@example.com",
    emailAlerts: true,
  });
  (createInAppNotification as jest.Mock).mockResolvedValue({ id: "notif-1" });
  (getCommunicationPreferences as jest.Mock).mockResolvedValue(defaultMatrix(true));
  (sendEmail as jest.Mock).mockResolvedValue(true);
});

describe("new-device login notification (#992)", () => {
  it("notifies once for an unrecognised device and not again for a known one", async () => {
    const first = await registerLoginDevice({
      walletAddress: WALLET,
      fingerprint: hashDeviceFingerprint("device-a"),
      userAgent: "Mozilla/5.0 (Macintosh) Chrome/126.0",
      coarseLocation: "London, UK",
    });

    expect(first.newDevice).toBe(true);
    expect(createInAppNotification).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(isKnownDevice(WALLET, hashDeviceFingerprint("device-a"))).toBe(true);

    const second = await registerLoginDevice({
      walletAddress: WALLET,
      fingerprint: hashDeviceFingerprint("device-a"),
      userAgent: "Mozilla/5.0 (Macintosh) Chrome/126.0",
      coarseLocation: "London, UK",
    });

    expect(second.newDevice).toBe(false);
    expect(createInAppNotification).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("still writes the in-app notification when the email channel is disabled", async () => {
    (getCommunicationPreferences as jest.Mock).mockResolvedValue(defaultMatrix(false));

    const result = await registerLoginDevice({
      walletAddress: WALLET,
      fingerprint: hashDeviceFingerprint("device-b"),
      coarseLocation: "Lagos, NG",
    });

    expect(result.newDevice).toBe(true);
    expect(createInAppNotification).toHaveBeenCalledTimes(1);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(result.inAppSent).toBe(true);
    expect(result.emailSent).toBe(false);
  });

  it("hashes the client device id and only exposes the hash", () => {
    const headers = { "x-device-fingerprint": "Device-A", "user-agent": "ignored" };
    const fromHeader = deviceFingerprintFromHeaders(headers);

    expect(fromHeader).toBe(hashDeviceFingerprint("device-a"));
    expect(fromHeader).not.toContain("Device-A");
    expect(deviceFingerprintFromHeaders({ "user-agent": "Mozilla/5.0" })).toBe(
      hashDeviceFingerprint("Mozilla/5.0")
    );
  });
});
