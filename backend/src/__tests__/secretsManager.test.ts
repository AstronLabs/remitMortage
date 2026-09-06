import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { SecretProvider } from "../services/secretsManager.js";

describe("SecretProvider", () => {
  it("refreshes expired values and keeps the previous value during the grace window", async () => {
    let now = 0;
    let calls = 0;
    const client = {
      send: jest.fn(async (command: GetSecretValueCommand) => {
        calls += 1;
        expect(command.input.SecretId).toBe("sendgrid");
        if (calls === 1) return { SecretString: JSON.stringify({ apiKey: "v1" }) };
        throw new Error("temporary AWS outage");
      }),
    };
    const provider = new SecretProvider(client, {
      ttlMs: 100,
      graceMs: 200,
      now: () => now,
    });

    await expect(provider.get("sendgrid", "apiKey")).resolves.toBe("v1");
    now = 150;
    await expect(provider.get("sendgrid", "apiKey")).resolves.toBe("v1");
    now = 400;
    await expect(provider.get("sendgrid", "apiKey")).rejects.toThrow("temporary AWS outage");
    expect(calls).toBe(3);
  });

  it("supports raw string secrets for App Runner secret injection", async () => {
    const provider = new SecretProvider({
      send: async () => ({ SecretString: "rotated-api-key" }),
    });

    await expect(provider.get("sendgrid", "value")).resolves.toBe("rotated-api-key");
  });
});