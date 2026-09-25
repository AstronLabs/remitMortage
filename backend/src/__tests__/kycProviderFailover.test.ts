// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import axios from "axios";
import {
  FailoverKycProvider,
  HttpKycProvider,
  KycFailoverAlert,
  normalizeProviderFields,
  sendKycFailoverAlert,
} from "../services/kycProviderFailover.js";
import type { OcrProvider, OcrResult } from "../services/ocrService.js";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockConfig = { alertWebhookUrl: "https://hooks.example.com/ops" as string | null };
jest.mock("../config.js", () => ({ loadConfig: () => mockConfig }));

const DOC = Buffer.from("document");

function ok(name: string): OcrResult {
  return { fields: { name, idNumber: null, address: null }, success: true, error: null };
}

function provider(impl: () => Promise<OcrResult>): OcrProvider & { extract: jest.Mock } {
  return { extract: jest.fn(impl) };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => jest.clearAllMocks());

describe("FailoverKycProvider", () => {
  let clock: number;
  let alerts: KycFailoverAlert[];

  beforeEach(() => {
    clock = 1_000_000;
    alerts = [];
  });

  function build(primary: OcrProvider, backup: OcrProvider) {
    return new FailoverKycProvider(primary, backup, {
      failureThreshold: 3,
      timeoutMs: 50,
      cooldownMs: 60_000,
      persistAlertAfterMs: 15 * 60_000,
      onAlert: (a) => {
        alerts.push(a);
      },
      now: () => clock,
    });
  }

  it("serves from the primary while it is healthy", async () => {
    const primary = provider(async () => ok("PRIMARY"));
    const backup = provider(async () => ok("BACKUP"));
    const failover = build(primary, backup);

    const result = await failover.extract(DOC, "application/pdf");

    expect(result.fields.name).toBe("PRIMARY");
    expect(backup.extract).not.toHaveBeenCalled();
    expect(failover.isFailoverActive()).toBe(false);
  });

  it("falls back to the backup for a single failed request without activating failover", async () => {
    const primary = provider(async () => {
      throw new Error("503 Service Unavailable");
    });
    const backup = provider(async () => ok("BACKUP"));
    const failover = build(primary, backup);

    const result = await failover.extract(DOC, "application/pdf");

    expect(result.fields.name).toBe("BACKUP");
    expect(failover.isFailoverActive()).toBe(false);
    expect(alerts).toHaveLength(0);
  });

  it("activates failover after repeated failures and stops calling the primary", async () => {
    const primary = provider(async () => {
      throw new Error("503 Service Unavailable");
    });
    const backup = provider(async () => ok("BACKUP"));
    const failover = build(primary, backup);

    for (let i = 0; i < 3; i++) await failover.extract(DOC, "application/pdf");
    await flush();

    expect(failover.isFailoverActive()).toBe(true);
    expect(alerts.map((a) => a.kind)).toEqual(["activated"]);
    expect(alerts[0].lastError).toBe("503 Service Unavailable");

    clock += 1_000;
    const result = await failover.extract(DOC, "application/pdf");
    expect(result.fields.name).toBe("BACKUP");
    expect(primary.extract).toHaveBeenCalledTimes(3);
  });

  it("counts timeouts and success=false results as primary failures", async () => {
    let call = 0;
    const primary = provider(() => {
      call += 1;
      if (call === 1) return new Promise<OcrResult>(() => {});
      return Promise.resolve({ ...ok("x"), success: false, error: "rate limited" });
    });
    const backup = provider(async () => ok("BACKUP"));
    const failover = build(primary, backup);

    for (let i = 0; i < 3; i++) {
      const result = await failover.extract(DOC, "application/pdf");
      expect(result.fields.name).toBe("BACKUP");
    }

    expect(failover.isFailoverActive()).toBe(true);
  });

  it("alerts once when failover persists past the threshold", async () => {
    const primary = provider(async () => {
      throw new Error("down");
    });
    const backup = provider(async () => ok("BACKUP"));
    const failover = build(primary, backup);

    for (let i = 0; i < 3; i++) await failover.extract(DOC, "application/pdf");

    clock += 15 * 60_000;
    await failover.extract(DOC, "application/pdf");
    clock += 1_000;
    await failover.extract(DOC, "application/pdf");
    await flush();

    expect(alerts.map((a) => a.kind)).toEqual(["activated", "persisting"]);
  });

  it("probes the primary after the cooldown and recovers when it succeeds", async () => {
    let healthy = false;
    const primary = provider(async () => {
      if (!healthy) throw new Error("down");
      return ok("PRIMARY");
    });
    const backup = provider(async () => ok("BACKUP"));
    const failover = build(primary, backup);

    for (let i = 0; i < 3; i++) await failover.extract(DOC, "application/pdf");
    expect(failover.isFailoverActive()).toBe(true);

    healthy = true;
    clock += 60_000;
    const result = await failover.extract(DOC, "application/pdf");
    await flush();

    expect(result.fields.name).toBe("PRIMARY");
    expect(failover.isFailoverActive()).toBe(false);
    expect(alerts.map((a) => a.kind)).toEqual(["activated", "recovered"]);
  });

  it("returns an ocrFailed result instead of throwing when both providers fail", async () => {
    const primary = provider(async () => {
      throw new Error("primary down");
    });
    const backup = provider(async () => {
      throw new Error("backup down");
    });
    const failover = build(primary, backup);

    const result = await failover.extract(DOC, "application/pdf");

    expect(result).toEqual({
      fields: { name: null, idNumber: null, address: null },
      success: false,
      error: "backup down",
    });
  });
});

describe("normalizeProviderFields", () => {
  it("maps vendor field spellings onto the primary provider's shape", () => {
    expect(
      normalizeProviderFields({
        first_name: "  Jane ",
        last_name: "Doe",
        document_number: "ab 123456",
        address: { line1: "1 Main St", city: "Lagos", postal_code: "100001", country: "NG" },
      })
    ).toEqual({
      name: "Jane Doe",
      idNumber: "AB123456",
      address: "1 Main St, Lagos, 100001, NG",
    });
  });

  it("returns nulls for missing or empty fields", () => {
    expect(normalizeProviderFields({ fullName: "", idNumber: null })).toEqual({
      name: null,
      idNumber: null,
      address: null,
    });
    expect(normalizeProviderFields(undefined)).toEqual({
      name: null,
      idNumber: null,
      address: null,
    });
  });
});

describe("HttpKycProvider", () => {
  it("posts the document and normalizes the response", async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { fullName: "John Smith", idNumber: "p1234567", address: "2 High St" } },
    });
    const backup = new HttpKycProvider({ url: "https://kyc.example.com/extract", apiKey: "k" });

    const result = await backup.extract(DOC, "application/pdf");

    expect(result).toEqual({
      fields: { name: "John Smith", idNumber: "P1234567", address: "2 High St" },
      success: true,
      error: null,
    });
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://kyc.example.com/extract",
      { document: DOC.toString("base64"), mimeType: "application/pdf" },
      expect.objectContaining({ headers: { Authorization: "Bearer k" } })
    );
  });

  it("throws on HTTP errors so the failover counts them", async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error("Request failed with status code 429"));
    const backup = new HttpKycProvider({ url: "https://kyc.example.com/extract" });

    await expect(backup.extract(DOC, "application/pdf")).rejects.toThrow("429");
  });
});

describe("sendKycFailoverAlert", () => {
  it("posts to the ops webhook", async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} });

    await sendKycFailoverAlert({
      kind: "activated",
      consecutiveFailures: 3,
      activeSince: new Date("2026-09-25T00:00:00Z"),
      lastError: "down",
    });

    const [url, payload] = mockedAxios.post.mock.calls[0];
    expect(url).toBe("https://hooks.example.com/ops");
    expect((payload as { text: string }).text).toContain("failover activated");
  });

  it("does nothing without a webhook configured", async () => {
    mockConfig.alertWebhookUrl = null;
    await sendKycFailoverAlert({
      kind: "recovered",
      consecutiveFailures: 0,
      activeSince: null,
      lastError: null,
    });
    expect(mockedAxios.post).not.toHaveBeenCalled();
    mockConfig.alertWebhookUrl = "https://hooks.example.com/ops";
  });
});
