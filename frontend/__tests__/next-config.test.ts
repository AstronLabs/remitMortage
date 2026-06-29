import { describe, expect, it } from "@jest/globals";

describe("Next.js content security policy headers", () => {
  it("applies a CSP header to all routes and restricts sources correctly", async () => {
    const { default: nextConfig } = await import("../next.config");

    expect(typeof nextConfig.headers).toBe("function");

    const headers = await nextConfig.headers();
    expect(Array.isArray(headers)).toBe(true);

    const route = headers.find((h: any) => h.source === "(/.*)" || h.source === "\\/(.*)" || h.source === "(/.*)" || h.source === "/(.*)");
    // Fallback to first item if matching by source fails
    const headerGroup = (route ?? headers[0]) as any;
    expect(headerGroup).toBeDefined();
    expect(Array.isArray(headerGroup.headers)).toBe(true);

    const cspHeader = headerGroup.headers.find((h: any) => typeof h.key === "string" && h.key.toLowerCase() === "content-security-policy");
    expect(cspHeader).toBeDefined();
    const value: string = cspHeader.value;

    expect(value).toContain("default-src 'self'");
    expect(value).toContain("script-src 'self'");
    expect(value).toContain("connect-src 'self'");
    expect(value).toContain("img-src 'self'");
    expect(value).toContain("https://ipfs.io");
    expect(value).toContain("https://cloudflare-ipfs.com");
    expect(value).toContain("https://gateway.pinata.cloud");
    expect(value).toContain("https://horizon-testnet.stellar.org");
    expect(value).toContain("https://soroban-testnet.stellar.org");
    // Ensure scripts are not allowed unsafe inline/eval, but styles may allow 'unsafe-inline'
    const scriptDirective = (value.match(/script-src[^;]*/)?.[0] ?? "").toLowerCase();
    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(scriptDirective).not.toContain("unsafe-eval");
  });
});
