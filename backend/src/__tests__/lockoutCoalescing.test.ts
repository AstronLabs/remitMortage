// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { getRedisClient } from "../services/redis.js";
import { sendLockoutNotificationEmail } from "../services/email.js";
import {
  _clearInMemoryLockouts,
  _resetLockoutNotificationCoalescer,
  recordFailedAttempt,
} from "../services/lockoutService.js";
import { DEFAULT_COALESCE_WINDOW_MS } from "../services/notificationCoalescer.js";

jest.mock("../services/redis.js", () => ({ getRedisClient: jest.fn(() => null) }));
jest.mock("../services/email.js", () => ({
  sendLockoutNotificationEmail: jest.fn().mockResolvedValue(true),
}));

const EMAIL = "borrower@example.com";
const IP = "203.0.113.7";

/**
 * Drives failed attempts until the identifier locks. The lockout email fires on
 * the crossing attempt (and every attempt after it), so the first `locked`
 * result is exactly the first notification trigger.
 */
async function failUntilLocked(identifier: string, email: string = EMAIL) {
  for (let i = 0; i < 50; i++) {
    const result = await recordFailedAttempt(identifier, email, IP);
    if (result.locked) return result;
  }
  throw new Error(`${identifier} never locked`);
}

describe("lockout notification coalescing", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    (getRedisClient as jest.Mock).mockReturnValue(null);
    _clearInMemoryLockouts();
    _resetLockoutNotificationCoalescer();
  });

  afterEach(() => {
    jest.useRealTimers();
    _clearInMemoryLockouts();
    _resetLockoutNotificationCoalescer();
  });

  it("sends the first lockout notification immediately", async () => {
    await failUntilLocked("acct-first");

    expect(sendLockoutNotificationEmail).toHaveBeenCalledTimes(1);
    expect(sendLockoutNotificationEmail).toHaveBeenCalledWith(EMAIL, expect.any(Number), IP);
  });

  it("coalesces rapid repeat lockouts into one combined email", async () => {
    await failUntilLocked("acct-repeat");

    // Two further lockouts inside the window are folded, not sent individually.
    await recordFailedAttempt("acct-repeat", EMAIL, IP);
    await recordFailedAttempt("acct-repeat", EMAIL, IP);
    expect(sendLockoutNotificationEmail).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(DEFAULT_COALESCE_WINDOW_MS);
    await Promise.resolve();

    expect(sendLockoutNotificationEmail).toHaveBeenCalledTimes(2);
    expect(sendLockoutNotificationEmail).toHaveBeenLastCalledWith(
      EMAIL,
      expect.any(Number),
      IP,
      3
    );
  });

  it("does not coalesce lockouts for different recipients", async () => {
    await failUntilLocked("acct-alpha", "alpha@example.com");
    await failUntilLocked("acct-beta", "beta@example.com");

    expect(sendLockoutNotificationEmail).toHaveBeenCalledTimes(2);
  });
});
