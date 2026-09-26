// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";

const ACME = {
  id: "acme",
  name: "Acme Homes",
  legalEntity: "Acme Lending LLC",
  hosts: ["loans.acme.com"],
  logoUrl: "https://cdn.acme.com/logo.png",
  colors: { header: "#112233", primary: "#ff6600" },
  senderDomain: "acme.com",
  supportEmail: "help@acme.com",
};

const BETA = {
  id: "beta",
  name: "Beta Mortgage",
  legalEntity: "Beta Finance Ltd",
  hosts: ["beta.example.org"],
  colors: { header: "#000000", primary: "#00aa00" },
  senderDomain: "beta.example.org",
  senderEmail: "loans@beta.example.org",
};

const mockConfig: Record<string, unknown> = {
  smtpFrom: "no-reply@remitmortgage.com",
  smtpHost: "localhost",
  smtpPort: 587,
  tenantBranding: [ACME, BETA],
};

jest.mock("../config.js", () => ({ loadConfig: () => mockConfig }));
jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  getCurrentTenant,
  parseTenant,
  resolveTenant,
  runWithTenant,
  tenantContext,
} from "../services/tenant.js";
import { getBrandedHtml, sendEmail, transporter } from "../services/email.js";
import { renderDepositReceipt, renderLockoutNotification } from "../services/emailTemplates.js";
import { tenantRouter } from "../routes/tenant.js";

function req(headers: Record<string, string>, hostname?: string) {
  return { headers, hostname } as any;
}

describe("tenant resolution", () => {
  beforeEach(() => {
    mockConfig.tenantBranding = [ACME, BETA];
  });

  it("resolves by X-Tenant-Id first, then Host, then the default", () => {
    expect(resolveTenant(req({ "x-tenant-id": "beta" }, "loans.acme.com")).id).toBe("beta");
    expect(resolveTenant(req({}, "LOANS.ACME.COM")).id).toBe("acme");
    expect(resolveTenant(req({ "x-tenant-id": "nope" }, "beta.example.org")).id).toBe("beta");
    expect(resolveTenant(req({}, "unknown.example.com")).id).toBe("default");
    expect(resolveTenant(req({})).id).toBe("default");
  });

  it("derives the sender from the tenant domain unless one is configured", () => {
    expect(resolveTenant(req({}, "loans.acme.com")).senderEmail).toBe("no-reply@acme.com");
    expect(resolveTenant(req({}, "beta.example.org")).senderEmail).toBe("loans@beta.example.org");
    expect(resolveTenant(req({})).senderEmail).toBe("no-reply@remitmortgage.com");
  });

  it("rejects unsafe or incomplete tenant records", () => {
    expect(parseTenant({ ...ACME, colors: { header: "red;}", primary: "#fff" } })).toBeNull();
    expect(parseTenant({ ...ACME, logoUrl: "http://cdn.acme.com/logo.png" })).toBeNull();
    expect(parseTenant({ ...ACME, senderEmail: "spoof@remitmortgage.com" })).toBeNull();
    expect(parseTenant({ ...ACME, id: "default" })).toBeNull();
    expect(parseTenant({ ...ACME, name: "" })).toBeNull();
    expect(parseTenant(ACME)).not.toBeNull();
  });

  it("skips a tenant that reuses another tenant's host", () => {
    mockConfig.tenantBranding = [ACME, { ...BETA, id: "copycat", hosts: ["loans.acme.com"] }];
    expect(resolveTenant(req({}, "loans.acme.com")).id).toBe("acme");
    expect(resolveTenant(req({ "x-tenant-id": "copycat" })).id).toBe("default");
  });

  it("uses the default tenant outside a request", () => {
    expect(getCurrentTenant().id).toBe("default");
    expect(runWithTenant("acme", () => getCurrentTenant().id)).toBe("acme");
    expect(runWithTenant("missing", () => getCurrentTenant().id)).toBe("default");
  });
});

describe("email rendering with a non-default tenant", () => {
  it("brands the wrapper with the tenant's name, logo, colors and support contact", () => {
    const html = runWithTenant("acme", () => getBrandedHtml("Hello", "<p>body</p>"));

    expect(html).toContain("<h1>Acme Lending LLC | Acme Homes</h1>");
    expect(html).toContain('<img src="https://cdn.acme.com/logo.png" alt="Acme Homes"');
    expect(html).toContain("background-color: #112233;");
    expect(html).toContain("background-color: #ff6600;");
    expect(html).toContain('href="mailto:help@acme.com"');
    expect(html).toContain("Acme Lending LLC. All rights reserved.");
    expect(html).not.toMatch(/RemitMortgage|AstronLabs|background-color: #(0f172a|3b82f6)/);
  });

  it("brands localized template subjects and bodies", () => {
    const receipt = runWithTenant("acme", () =>
      renderDepositReceipt("en", { amount: "10", transactionId: "tx1" })
    );
    expect(receipt.subject).toBe("Deposit Receipt - Acme Homes");
    expect(receipt.html).not.toMatch(/RemitMortgage|AstronLabs/);

    const lockout = runWithTenant("beta", () =>
      renderLockoutNotification("es", { lockoutMinutes: 5 })
    );
    expect(lockout.subject).toContain("Beta Mortgage");
    expect(lockout.html).toContain("cuenta de Beta Mortgage");
    expect(lockout.html).not.toMatch(/RemitMortgage|AstronLabs/);
  });

  it("keeps the default branding for the default tenant", () => {
    const receipt = renderDepositReceipt("en", { amount: "10", transactionId: "tx1" });
    expect(receipt.subject).toBe("Deposit Receipt - RemitMortgage");
    expect(receipt.html).toContain("<h1>AstronLabs | RemitMortgage</h1>");
  });

  it("escapes tenant values inserted into HTML", () => {
    mockConfig.tenantBranding = [{ ...ACME, name: '<script>alert("x")</script>' }];
    const html = runWithTenant("acme", () => getBrandedHtml("t", ""));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    mockConfig.tenantBranding = [ACME, BETA];
  });

  it("sends from the tenant's sender address", async () => {
    const sendMail = jest.spyOn(transporter, "sendMail").mockResolvedValue({} as any);
    await runWithTenant("beta", () => sendEmail("user@example.com", "Hi", "<p>x</p>"));
    await sendEmail("user@example.com", "Hi", "<p>x</p>");
    expect(sendMail.mock.calls[0][0]).toMatchObject({ from: "loans@beta.example.org" });
    expect(sendMail.mock.calls[1][0]).toMatchObject({ from: "no-reply@remitmortgage.com" });
    sendMail.mockRestore();
  });
});

describe("tenant isolation under concurrent requests", () => {
  const app = express();
  app.use(tenantContext);
  app.use("/api/tenant", tenantRouter);
  app.get("/render", async (_req, res) => {
    // Yield across several ticks so requests for different tenants interleave.
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));
    const before = getCurrentTenant().id;
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));
    const html = getBrandedHtml("t", "");
    res.json({ before, after: getCurrentTenant().id, header: html.match(/<h1>(.*)<\/h1>/)?.[1] });
  });

  it("never leaks one tenant's branding into another tenant's response", async () => {
    const cases = [
      { set: { Host: "loans.acme.com" }, id: "acme", header: "Acme Lending LLC | Acme Homes" },
      { set: { "X-Tenant-Id": "beta" }, id: "beta", header: "Beta Finance Ltd | Beta Mortgage" },
      { set: {}, id: "default", header: "AstronLabs | RemitMortgage" },
    ];

    const runs = Array.from({ length: 60 }, (_, i) => cases[i % cases.length]);
    const responses = await Promise.all(
      runs.map((c) => request(app).get("/render").set(c.set as Record<string, string>))
    );

    responses.forEach((res, i) => {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ before: runs[i].id, after: runs[i].id, header: runs[i].header });
    });
  });

  it("serves the resolved tenant's public branding", async () => {
    const res = await request(app).get("/api/tenant/branding").set("Host", "loans.acme.com");
    expect(res.body).toEqual({
      id: "acme",
      name: "Acme Homes",
      legalEntity: "Acme Lending LLC",
      logoUrl: "https://cdn.acme.com/logo.png",
      colors: { header: "#112233", primary: "#ff6600" },
      supportEmail: "help@acme.com",
    });
    expect(res.body).not.toHaveProperty("senderEmail");
  });
});
