// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Automated open-redirect audit (issue #759).
 *
 * For every registered redirect-accepting path, asserts that an
 * external/unallowlisted target is rejected (falls back) rather than
 * followed — and that adding a new redirect-accepting path without registry
 * coverage fails CI (see scripts/check-redirect-coverage.mjs).
 */

import fs from "fs";
import path from "path";
import {
  getSafeRedirectTarget,
  isSafeRedirectTarget,
  resolveSafeRedirect,
} from "../security/redirectValidation.js";
import { REDIRECT_PATH_REGISTRY } from "../security/redirectRegistry.js";

describe("open-redirect validation (issue #759)", () => {
  it("rejects external / unallowlisted targets instead of following them", () => {
    const evil = [
      "https://evil.example.com/phish",
      "http://evil.example.com",
      "//evil.example.com/dashboard",
      "/\\evil.example.com",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "https://remitmortgage.com.evil.com/",
      "/dashboard2-unallowlisted".replace("unallowlisted", "exfil"),
      "https:evil",
      "/%2fevil.example.com",
      " /dashboard\nSet-Cookie: x=1",
      "",
      null,
      undefined,
      42,
    ];
    for (const target of evil) {
      expect(isSafeRedirectTarget(target)).toBe(false);
      expect(resolveSafeRedirect(target)).toBe("/");
      expect(resolveSafeRedirect(target, "/dashboard")).toBe("/dashboard");
    }
  });

  it("accepts allowlisted in-app targets (exact path or sub-path, with query/hash)", () => {
    const good = [
      "/",
      "/dashboard",
      "/dashboard/",
      "/dashboard?tab=loans",
      "/onboarding/step-2#top",
      "/invest/pool-1",
      "/admin/loans?status=pending",
      "/tx/abc123?type=deposit",
      "/repay",
      "/share/invite-1",
    ];
    for (const target of good) {
      expect(isSafeRedirectTarget(target)).toBe(true);
      expect(resolveSafeRedirect(target)).toBe(target);
    }
  });

  it("getSafeRedirectTarget never returns the raw external value", () => {
    const r1 = getSafeRedirectTarget({ query: { redirect: "https://evil.example.com" } });
    expect(r1.target).toBe("/");
    expect(r1.rejected).toContain("evil");

    const r2 = getSafeRedirectTarget({ query: { returnTo: "/dashboard" } });
    expect(r2.target).toBe("/dashboard");
    expect(r2.rejected).toBeNull();

    const r3 = getSafeRedirectTarget({ body: { callbackUrl: "//evil.example.com/x" } });
    expect(r3.target).toBe("/");
    expect(r3.rejected).not.toBeNull();

    const r4 = getSafeRedirectTarget({ query: {} });
    expect(r4.target).toBe("/");
  });

  it("does not let prefix-squatting pass (/dashboard principals, not /dashboardX)", () => {
    expect(isSafeRedirectTarget("/dashboar")).toBe(false);
    expect(isSafeRedirectTarget("/dashboardX")).toBe(false);
    expect(isSafeRedirectTarget("/adminx")).toBe(false);
  });
});

describe("redirect registry completeness (issue #759)", () => {
  it("covers the middleware gate, the post-login consumer, and backend return-to paths", () => {
    const locations = REDIRECT_PATH_REGISTRY.map((e) => e.location).join("\n");
    expect(locations).toContain("middleware.ts");
    expect(locations).toContain("post-login consumer");
    expect(locations).toContain("redirectValidation.ts");
    for (const entry of REDIRECT_PATH_REGISTRY) {
      expect(entry.validation.length).toBeGreaterThan(10);
      expect(entry.coveredBy).toContain("openRedirectAudit");
    }
  });

  it("has no unvalidated redirect sinks in backend/frontend sources", () => {
    const backendRoutes = path.join(__dirname, "..", "routes");
    const sinkPattern = /res\.redirect\s*\(\s*(?!resolveSafeRedirect|getSafeRedirectTarget)[^)]*req\./;
    for (const file of fs.readdirSync(backendRoutes).filter((f) => f.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(backendRoutes, file), "utf8");
      expect(sinkPattern.test(src)).toBe(false);
    }
    const middlewarePath = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "frontend",
      "src",
      "middleware.ts"
    );
    const middlewareSrc = fs.readFileSync(middlewarePath, "utf8");
    // The middleware gate must validate before redirecting.
    expect(middlewareSrc).toContain("resolveSafeRedirect");
  });
});
