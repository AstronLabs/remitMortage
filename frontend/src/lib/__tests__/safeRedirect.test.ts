// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  isSafeRedirectTarget,
  resolveSafeRedirect,
} from "../safeRedirect";

/**
 * Frontend mirror of the open-redirect audit (issue #759): the post-login
 * consumer must reject external/unallowlisted `?redirect=` targets rather
 * than following them.
 */
describe("safeRedirect (issue #759)", () => {
  it("rejects external targets and falls back instead of following them", () => {
    const evil = [
      "https://evil.example.com/phish",
      "//evil.example.com/dashboard",
      "/\\evil.example.com",
      "javascript:alert(1)",
      "data:text/html,hi",
      "/dashboardX",
      "",
    ];
    for (const target of evil) {
      expect(isSafeRedirectTarget(target)).toBe(false);
      expect(resolveSafeRedirect(target, "/dashboard")).toBe("/dashboard");
    }
  });

  it("accepts allowlisted in-app targets", () => {
    const good = ["/", "/dashboard", "/dashboard?tab=loans", "/onboarding"];
    for (const target of good) {
      expect(isSafeRedirectTarget(target)).toBe(true);
      expect(resolveSafeRedirect(target)).toBe(target);
    }
  });
});
