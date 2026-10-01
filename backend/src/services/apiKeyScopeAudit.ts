// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Automated least-privilege scope audit for third-party credentials (issue
 * #772). This module holds the pure, testable core:
 *
 * - {@link resolveGrantedScopes} reads the scopes actually granted to a
 *   provisioned credential (operator-confirmed override, or the provider's
 *   common default-provisioning bundle otherwise — see
 *   `apiKeyScopeRegistry.ts`).
 * - {@link auditIntegration} compares granted scopes against
 *   `capabilityScopes` (the minimum this app's code can ever need) and
 *   observed usage, flagging any granted scope with zero exercised calls.
 *
 * This never revokes anything — see `docs/API_KEY_SCOPE_AUDIT.md` for the
 * human review/reduction process. The scheduled job
 * (`jobs/apiKeyScopeAudit.ts`) only reports.
 */

import type { ApiIntegrationDefinition } from "./apiKeyScopeRegistry.js";
import type { CapabilityUsageInfo } from "./apiScopeUsageTracker.js";

export function resolveGrantedScopes(
  def: ApiIntegrationDefinition,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const raw = env[def.grantedScopesEnvVar];
  if (!raw) return def.defaultGrantedScopes;
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : def.defaultGrantedScopes;
}

export interface ScopeFinding {
  scope: string;
  /** Capabilities our code has that require this scope (empty = our code has no use for this scope at all). */
  capabilitiesRequiringScope: string[];
  /** Which of those capabilities have actually been exercised at least once. */
  usedCapabilities: string[];
  /** True when this granted scope has never been exercised by any capability. */
  overProvisioned: boolean;
}

export interface IntegrationAuditResult {
  integration: string;
  displayName: string;
  grantedScopes: string[];
  /** The full set of scopes this app's code could ever need — derived from `capabilityScopes`. */
  minimumRequiredScopes: string[];
  findings: ScopeFinding[];
  overProvisionedScopes: string[];
}

/**
 * Compares one integration's granted scopes against what our code actually
 * exercises. A granted scope is over-provisioned when either:
 * - no capability of ours requires it at all (our code has no use for it), or
 * - a capability requires it, but that capability has never been called.
 */
export function auditIntegration(
  def: ApiIntegrationDefinition,
  grantedScopes: readonly string[],
  usage: Readonly<Record<string, CapabilityUsageInfo>>
): IntegrationAuditResult {
  const minimumRequiredScopes = Array.from(new Set(Object.values(def.capabilityScopes))).sort();

  const findings: ScopeFinding[] = grantedScopes.map((scope) => {
    const capabilitiesRequiringScope = Object.entries(def.capabilityScopes)
      .filter(([, requiredScope]) => requiredScope === scope)
      .map(([capability]) => capability)
      .sort();

    const usedCapabilities = capabilitiesRequiringScope.filter(
      (capability) => (usage[capability]?.callCount ?? 0) > 0
    );

    return {
      scope,
      capabilitiesRequiringScope,
      usedCapabilities,
      overProvisioned: usedCapabilities.length === 0,
    };
  });

  return {
    integration: def.integration,
    displayName: def.displayName,
    grantedScopes: [...grantedScopes],
    minimumRequiredScopes,
    findings,
    overProvisionedScopes: findings.filter((f) => f.overProvisioned).map((f) => f.scope),
  };
}
