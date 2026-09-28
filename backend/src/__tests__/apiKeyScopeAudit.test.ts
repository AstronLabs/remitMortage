// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Unit tests for the API key least-privilege scope audit (issue #772).
 *
 * Acceptance criteria under test:
 * 1. A scheduled audit flags any third-party API key whose granted scope
 *    exceeds its observed actual usage.
 * 2. A newly-observed (or not-yet-sustained) integration is never flagged —
 *    only after `API_KEY_SCOPE_AUDIT_MIN_OBSERVATION_DAYS`.
 */

import { promises as fs } from "fs";
import {
  auditIntegration,
  resolveGrantedScopes,
} from "../services/apiKeyScopeAudit.js";
import type { ApiIntegrationDefinition } from "../services/apiKeyScopeRegistry.js";
import type { CapabilityUsageInfo } from "../services/apiScopeUsageTracker.js";
import { loadBaseline, runApiKeyScopeAuditJob, saveBaseline } from "../jobs/apiKeyScopeAudit.js";

jest.mock("../services/email.js", () => ({
  sendEmail: jest.fn().mockResolvedValue(true),
  getBrandedHtml: jest.fn((_title: string, body: string) => `<html>${body}</html>`),
}));

jest.mock("../config.js", () => ({
  loadConfig: jest.fn(() => ({
    complianceAlertEmail: "security@remitmortgage.com",
  })),
}));

jest.mock("../services/db.js", () => ({
  prisma: { auditLog: { create: jest.fn().mockResolvedValue({}) } },
}));

jest.mock("../utils/logger.js", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

function def(overrides: Partial<ApiIntegrationDefinition> = {}): ApiIntegrationDefinition {
  return {
    integration: "test_integration",
    displayName: "Test Integration",
    credentialEnvVars: ["TEST_API_KEY"],
    // "scope_a" backs a real capability; "scope_b" backs nothing our code
    // ever calls — always over-provisioned once sustained.
    capabilityScopes: { do_thing: "scope_a" },
    grantedScopesEnvVar: "TEST_GRANTED_SCOPES",
    defaultGrantedScopes: ["scope_a", "scope_b"],
    isConfigured: () => true,
    ...overrides,
  };
}

function usage(callCount: number): Record<string, CapabilityUsageInfo> {
  return { do_thing: { callCount, lastUsedAt: callCount > 0 ? new Date() : null } };
}

describe("resolveGrantedScopes (issue #772)", () => {
  it("falls back to the documented default when no override is set", () => {
    expect(resolveGrantedScopes(def(), {} as NodeJS.ProcessEnv)).toEqual(["scope_a", "scope_b"]);
  });

  it("honours a comma-separated override", () => {
    expect(
      resolveGrantedScopes(def(), { TEST_GRANTED_SCOPES: "scope_a, scope_c" } as NodeJS.ProcessEnv)
    ).toEqual(["scope_a", "scope_c"]);
  });

  it("falls back to the default for an empty/whitespace override", () => {
    expect(resolveGrantedScopes(def(), { TEST_GRANTED_SCOPES: " , " } as NodeJS.ProcessEnv)).toEqual([
      "scope_a",
      "scope_b",
    ]);
  });
});

describe("auditIntegration (issue #772)", () => {
  it("does not flag a granted scope backed by a capability that has been used", () => {
    const result = auditIntegration(def(), ["scope_a"], usage(3));
    expect(result.findings).toEqual([
      {
        scope: "scope_a",
        capabilitiesRequiringScope: ["do_thing"],
        usedCapabilities: ["do_thing"],
        overProvisioned: false,
      },
    ]);
    expect(result.overProvisionedScopes).toEqual([]);
  });

  it("flags a granted scope whose backing capability has never been called", () => {
    const result = auditIntegration(def(), ["scope_a"], usage(0));
    expect(result.overProvisionedScopes).toEqual(["scope_a"]);
  });

  it("flags a granted scope that maps to no capability our code has at all", () => {
    const result = auditIntegration(def(), ["scope_b"], usage(3));
    expect(result.findings[0].capabilitiesRequiringScope).toEqual([]);
    expect(result.overProvisionedScopes).toEqual(["scope_b"]);
  });

  it("derives minimumRequiredScopes from the distinct values of capabilityScopes", () => {
    const result = auditIntegration(
      def({ capabilityScopes: { read_thing: "scope_a", write_thing: "scope_c" } }),
      [],
      {}
    );
    expect(result.minimumRequiredScopes).toEqual(["scope_a", "scope_c"]);
  });
});

describe("runApiKeyScopeAuditJob (issue #772)", () => {
  const tmpBaseline = (name: string) => `/tmp/api-scope-audit-baseline-${process.pid}-${name}.json`;

  afterEach(async () => {
    jest.clearAllMocks();
  });

  it("never flags a scope on the first (newly-observed) run, even with zero usage", async () => {
    const file = tmpBaseline("fresh");
    await fs.rm(file, { force: true });

    const { report } = await runApiKeyScopeAuditJob({
      integrations: [def()],
      getUsage: async () => usage(0),
      baselineFile: file,
      recipients: ["security@remitmortgage.com"],
    });

    expect(report.integrations).toHaveLength(1);
    expect(report.integrations[0].newlyObserved).toBe(true);
    expect(report.integrations[0].observedForDays).toBe(0);
    expect(report.integrations[0].overProvisionedScopes).toEqual([]);
    expect(report.flaggedScopeCount).toBe(0);

    const baseline = await loadBaseline(file);
    expect(baseline.test_integration).toEqual(expect.any(String));
  });

  it("does not flag a scope before the minimum observation window has elapsed", async () => {
    const file = tmpBaseline("too-young");
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    await saveBaseline({ test_integration: tenDaysAgo }, file);

    const { report } = await runApiKeyScopeAuditJob({
      integrations: [def()],
      getUsage: async () => usage(0),
      baselineFile: file,
      recipients: ["security@remitmortgage.com"],
    });

    expect(report.integrations[0].newlyObserved).toBe(false);
    expect(report.integrations[0].observedForDays).toBe(10);
    expect(report.integrations[0].overProvisionedScopes).toEqual([]);
  });

  it("flags a sustained never-used scope once the observation window has passed", async () => {
    const file = tmpBaseline("sustained-unused");
    const wellPast = new Date(Date.now() - 45 * 86_400_000).toISOString();
    await saveBaseline({ test_integration: wellPast }, file);

    const { report } = await runApiKeyScopeAuditJob({
      integrations: [def()],
      getUsage: async () => usage(0),
      baselineFile: file,
      recipients: ["security@remitmortgage.com"],
    });

    expect(report.integrations[0].overProvisionedScopes.sort()).toEqual(["scope_a", "scope_b"]);
    expect(report.flaggedScopeCount).toBe(2);
  });

  it("does not flag the scope backing a capability that has genuinely been used, once sustained", async () => {
    const file = tmpBaseline("sustained-used");
    const wellPast = new Date(Date.now() - 45 * 86_400_000).toISOString();
    await saveBaseline({ test_integration: wellPast }, file);

    const { report } = await runApiKeyScopeAuditJob({
      integrations: [def()],
      getUsage: async () => usage(7),
      baselineFile: file,
      recipients: ["security@remitmortgage.com"],
    });

    // scope_a is backed by do_thing, which was called — never flagged.
    // scope_b backs no capability at all — always flagged once sustained.
    expect(report.integrations[0].overProvisionedScopes).toEqual(["scope_b"]);
  });

  it("never flags a non-auditable integration, but still inventories it", async () => {
    const file = tmpBaseline("non-auditable");
    const wellPast = new Date(Date.now() - 45 * 86_400_000).toISOString();
    await saveBaseline({ wallet_integration: wellPast }, file);

    const { report } = await runApiKeyScopeAuditJob({
      integrations: [def({ integration: "wallet_integration", auditable: false })],
      getUsage: async () => usage(0),
      baselineFile: file,
      recipients: ["security@remitmortgage.com"],
    });

    expect(report.integrations).toHaveLength(1);
    expect(report.integrations[0].integration).toBe("wallet_integration");
    expect(report.integrations[0].overProvisionedScopes).toEqual([]);
    expect(report.flaggedScopeCount).toBe(0);
  });

  it("skips an integration that is not configured in this environment", async () => {
    const file = tmpBaseline("unconfigured");
    const { report } = await runApiKeyScopeAuditJob({
      integrations: [def({ isConfigured: () => false })],
      getUsage: async () => usage(0),
      baselineFile: file,
      recipients: ["security@remitmortgage.com"],
    });
    expect(report.integrations).toHaveLength(0);
  });

  it("emails the digest recipients when scopes are flagged", async () => {
    const { sendEmail } = jest.requireMock("../services/email.js") as { sendEmail: jest.Mock };
    sendEmail.mockClear();

    const file = tmpBaseline("emails-on-flag");
    const wellPast = new Date(Date.now() - 45 * 86_400_000).toISOString();
    await saveBaseline({ test_integration: wellPast }, file);

    const { emailed } = await runApiKeyScopeAuditJob({
      integrations: [def()],
      getUsage: async () => usage(0),
      baselineFile: file,
      recipients: ["security@remitmortgage.com"],
    });

    expect(emailed).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when every granted scope is backed by a used capability", async () => {
    const { sendEmail } = jest.requireMock("../services/email.js") as { sendEmail: jest.Mock };
    sendEmail.mockClear();

    const file = tmpBaseline("no-flags-no-email");
    const wellPast = new Date(Date.now() - 45 * 86_400_000).toISOString();
    await saveBaseline({ fully_used_integration: wellPast }, file);

    const fullyUsedDef = def({
      integration: "fully_used_integration",
      capabilityScopes: { do_thing: "scope_a", do_other_thing: "scope_b" },
    });

    const { report, emailed } = await runApiKeyScopeAuditJob({
      integrations: [fullyUsedDef],
      getUsage: async () => ({
        do_thing: { callCount: 5, lastUsedAt: new Date() },
        do_other_thing: { callCount: 2, lastUsedAt: new Date() },
      }),
      baselineFile: file,
      recipients: ["security@remitmortgage.com"],
    });

    expect(report.flaggedScopeCount).toBe(0);
    expect(emailed).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("writes an AuditLog row summarizing the run", async () => {
    const { prisma } = jest.requireMock("../services/db.js") as {
      prisma: { auditLog: { create: jest.Mock } };
    };
    prisma.auditLog.create.mockClear();

    const file = tmpBaseline("audit-log");
    const wellPast = new Date(Date.now() - 45 * 86_400_000).toISOString();
    await saveBaseline({ test_integration: wellPast }, file);

    await runApiKeyScopeAuditJob({
      integrations: [def()],
      getUsage: async () => usage(0),
      baselineFile: file,
      recipients: ["security@remitmortgage.com"],
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "API_KEY_SCOPE_AUDIT_REPORT" }),
      })
    );
  });
});
