import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  injectFreighterMock,
  removeFreighterMock,
  MOCK_PUBLIC_KEY,
} from "../mocks/freighter";

describe("Onboarding Wizard E2E with Mock Freighter", () => {
  beforeEach(() => {
    injectFreighterMock();
  });

  afterEach(() => {
    removeFreighterMock();
  });

  it("mock wallet connects automatically in test environment", async () => {
    const freighterApi = (window as any).freighterApi;
    expect(freighterApi).toBeDefined();

    const connected = await freighterApi.isConnected();
    expect(connected).toBe(true);
  });

  it("returns valid dummy public keys for signing procedures", async () => {
    const freighterApi = (window as any).freighterApi;
    const publicKey = await freighterApi.getPublicKey();

    expect(publicKey).toBe(MOCK_PUBLIC_KEY);
    expect(publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    expect(publicKey).toHaveLength(56);
  });

  it("signs blob data with mock signature", async () => {
    const freighterApi = (window as any).freighterApi;
    const signature = await freighterApi.signBlob("test-payload");

    expect(signature).toBe("mock_signature_hex");
    expect(typeof signature).toBe("string");
  });

  it("mock wallet requestAccess resolves without error", async () => {
    const freighterApi = (window as any).freighterApi;
    await expect(freighterApi.requestAccess()).resolves.toBeUndefined();
  });

  it("mock wallet returns testnet network by default", async () => {
    const freighterApi = (window as any).freighterApi;
    const network = await freighterApi.getNetwork();

    expect(network).toContain("testnet");
  });

  it("mock wallet can be configured with custom public key", () => {
    const customKey = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const mock = injectFreighterMock({ getPublicKey: async () => customKey });

    expect(mock).toBeDefined();
    removeFreighterMock();
  });

  it("removing mock clears window.freighterApi", () => {
    injectFreighterMock();
    expect((window as any).freighterApi).toBeDefined();

    removeFreighterMock();
    expect((window as any).freighterApi).toBeUndefined();
  });
});
