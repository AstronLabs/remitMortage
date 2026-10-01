// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Credential-stuffing detection (issue #737).
 * Simulates many distinct accounts failing from one correlated source in a
 * short window and asserts adaptive, source-scoped lockout.
 */

import {
  recordCredentialFailure,
  isStuffingSourceLocked,
  getAdaptiveAction,
  _clearCredentialStuffingState,
} from "../services/credentialStuffing.js";

describe("credential stuffing detection and adaptive lockout (issue #737)", () => {
  beforeEach(() => {
    _clearCredentialStuffingState();
  });

  it("flags a many-accounts / correlated-source / short-window wave and locks that source", () => {
    const alerts: any[] = [];
    let detected = false;
    // 25 distinct accounts, plausible passwords, one IP + shared fingerprint, 2-minute window.
    for (let i = 0; i < 25; i++) {
      const result = recordCredentialFailure(
        {
          account: `victim-${i}@example.com`,
          ip: "203.0.113.44",
          asn: "AS64500",
          fingerprint: "fp-shared-bot",
          atMs: 1_000_000 + i * 5_000,
        },
        {
          windowMs: 5 * 60 * 1000,
          distinctAccountsThreshold: 10,
          totalFailuresThreshold: 20,
          lockoutMs: 15 * 60 * 1000,
          onAlert: (episode) => alerts.push(episode),
        }
      );
      detected = detected || result.detected;
    }

    expect(detected).toBe(true);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0].distinctAccounts).toBeGreaterThanOrEqual(10);

    // Adaptive lockout is scoped to the detected source…
    const locked = isStuffingSourceLocked(
      { ip: "203.0.113.44", asn: "AS64500", fingerprint: "fp-shared-bot" },
      1_000_000 + 25 * 5_000
    );
    expect(locked.locked).toBe(true);
    expect(locked.requireCaptcha).toBe(true);

    const action = getAdaptiveAction(locked.sources[0], 1_000_000 + 25 * 5_000);
    expect(action.locked).toBe(true);
    expect(action.requireCaptcha).toBe(true);
    expect(action.delayMs).toBeGreaterThan(0);
  });

  it("leaves legitimate users on unrelated sources unaffected", () => {
    const alerts: any[] = [];
    for (let i = 0; i < 25; i++) {
      recordCredentialFailure(
        {
          account: `victim-${i}@example.com`,
          ip: "203.0.113.44",
          fingerprint: "fp-shared-bot",
          atMs: 2_000_000 + i * 4_000,
        },
        {
          windowMs: 5 * 60 * 1000,
          distinctAccountsThreshold: 10,
          totalFailuresThreshold: 20,
          onAlert: (e) => alerts.push(e),
        }
      );
    }
    expect(alerts.length).toBeGreaterThanOrEqual(1);

    const innocent = isStuffingSourceLocked(
      { ip: "198.51.100.7", fingerprint: "fp-legit-browser" },
      2_000_000 + 25 * 4_000
    );
    expect(innocent.locked).toBe(false);

    // A lone failure (even repeated for one account) is per-account business,
    // not a stuffing wave: distinct-account threshold not met.
    _clearCredentialStuffingState();
    let flagged = false;
    for (let i = 0; i < 8; i++) {
      const r = recordCredentialFailure(
        { account: "same-user@example.com", ip: "198.51.100.7", atMs: 3_000_000 + i * 1_000 },
        { windowMs: 5 * 60 * 1000, distinctAccountsThreshold: 10, totalFailuresThreshold: 20 }
      );
      flagged = flagged || r.detected;
    }
    expect(flagged).toBe(false);
  });
});
