// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Breached-credential checks for admin passwords (issue #979).
 */

import { createHash } from "crypto";

jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import logger from "../utils/logger.js";
import {
  checkBreachedPassword,
  defaultRangeLookup,
  validateAdminPassword,
} from "../services/breachedPassword.js";

const BREACHED = "correct horse battery staple";
const CLEAN = "a-strong-unlisted-passphrase-91";

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex").toUpperCase();
}

/** A fake range service that knows only the BREACHED password. */
function fakeLookup() {
  const hash = sha1(BREACHED);
  return jest.fn(async (prefix: string) => {
    const lines = ["0018A45C4D1DEF81644B54AB7F969B88D65:3", "00D4F6E8FA6EECAD2A3AA415EEC418D38EC:0"];
    if (prefix === hash.slice(0, 5)) lines.push(`${hash.slice(5)}:24230577`);
    return lines.join("\r\n");
  });
}

beforeEach(() => jest.clearAllMocks());

describe("checkBreachedPassword", () => {
  it("sends only the first five characters of the SHA-1 hash", async () => {
    const lookup = fakeLookup();
    await checkBreachedPassword(BREACHED, lookup);

    expect(lookup).toHaveBeenCalledTimes(1);
    const [sent] = lookup.mock.calls[0];
    expect(sent).toBe(sha1(BREACHED).slice(0, 5));
    expect(sent).toHaveLength(5);
    expect(sent).not.toContain(BREACHED);
  });

  it("flags a breached password", async () => {
    await expect(checkBreachedPassword(BREACHED, fakeLookup())).resolves.toEqual({ status: "breached" });
  });

  it("passes a clean password", async () => {
    await expect(checkBreachedPassword(CLEAN, fakeLookup())).resolves.toEqual({ status: "clean" });
  });

  it("ignores padding entries with a zero count", async () => {
    const hash = sha1(CLEAN);
    const lookup = jest.fn(async () => `${hash.slice(5)}:0`);
    await expect(checkBreachedPassword(CLEAN, lookup)).resolves.toEqual({ status: "clean" });
  });

  it("fails open with a logged warning when the service is unreachable", async () => {
    const lookup = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(checkBreachedPassword(BREACHED, lookup)).resolves.toEqual({ status: "unavailable" });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("default lookup requests the range URL with padding and only the prefix", async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200, text: async () => "" }));
    const original = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      await defaultRangeLookup("ABCDE");
    } finally {
      global.fetch = original;
    }
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.pwnedpasswords.com/range/ABCDE");
    expect((init.headers as Record<string, string>)["Add-Padding"]).toBe("true");
  });
});

describe("validateAdminPassword", () => {
  it("rejects a breached password without revealing how often it appeared", async () => {
    const result = await validateAdminPassword(BREACHED, fakeLookup());

    expect(result).toMatchObject({ ok: false, error: "password_breached" });
    if (!result.ok) expect(result.message).not.toMatch(/\d/);
  });

  it("accepts a clean password", async () => {
    await expect(validateAdminPassword(CLEAN, fakeLookup())).resolves.toEqual({ ok: true });
  });

  it("still accepts a long password when the lookup service fails", async () => {
    const lookup = jest.fn(async () => {
      throw new Error("timeout");
    });
    await expect(validateAdminPassword(CLEAN, lookup)).resolves.toEqual({ ok: true });
    expect(logger.warn).toHaveBeenCalled();
  });

  it("rejects a short password before any lookup", async () => {
    const lookup = fakeLookup();
    const result = await validateAdminPassword("short", lookup);

    expect(result).toMatchObject({ ok: false, error: "password_too_short" });
    expect(lookup).not.toHaveBeenCalled();
  });
});
