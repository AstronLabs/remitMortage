// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Scheduled API key scope audit (issue #772).
 *
 * For each configured, auditable third-party integration (see
 * `services/apiKeyScopeRegistry.ts`), compares its granted provider scope
 * against capability usage recorded by `services/apiScopeUsageTracker.ts`
 * and flags any granted scope that has never actually been exercised.
 *
 * "Sustained observation" guard: a scope is only ever flagged once the
 * integration has been under observation for at least
 * `API_KEY_SCOPE_AUDIT_MIN_OBSERVATION_DAYS` (default 30) — a freshly
 * deployed or freshly discovered integration cannot yet prove a scope
 * unused just because nothing has called it on day one. Observation start
 * times persist to a small JSON baseline file
 * (`API_KEY_SCOPE_AUDIT_BASELINE_PATH`, default
 * `<cwd>/storage/api-scope-audit-baseline.json`), mirroring the pattern
 * `jobs/unusedIndexAudit.ts` uses for its own sustained-idle snapshot.
 *
 * This job NEVER revokes or modifies any credential. It only reports —
 * scope reduction is always a human decision. See
 * `docs/API_KEY_SCOPE_AUDIT.md` for the review process.
 */

import { promises as fs } from "fs";
import path from "path";
import { prisma } from "../services/db.js";
import { getBrandedHtml, sendEmail } from "../services/email.js";
import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";
import { API_INTEGRATIONS, type ApiIntegrationDefinition } from "../services/apiKeyScopeRegistry.js";
import {
  auditIntegration,
  resolveGrantedScopes,
  type IntegrationAuditResult,
} from "../services/apiKeyScopeAudit.js";
import { getUsageForIntegration, type CapabilityUsageInfo } from "../services/apiScopeUsageTracker.js";

export const API_KEY_SCOPE_AUDIT_MIN_OBSERVATION_DAYS = Number(
  process.env.API_KEY_SCOPE_AUDIT_MIN_OBSERVATION_DAYS ?? 30
);

export function baselinePath(): string {
  return (
    process.env.API_KEY_SCOPE_AUDIT_BASELINE_PATH ??
    path.join(process.cwd(), "storage", "api-scope-audit-baseline.json")
  );
}

/** Integration id -> ISO timestamp of the first audit run that observed it. */
export type AuditBaseline = Record<string, string>;

export async function loadBaseline(file = baselinePath()): Promise<AuditBaseline> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    logger.warn(
      "[api-scope-audit] Could not read prior baseline; treating every integration as newly observed",
      { err }
    );
    return {};
  }
}

export async function saveBaseline(baseline: AuditBaseline, file = baselinePath()): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(baseline, null, 2), "utf8");
  } catch (err) {
    logger.warn("[api-scope-audit] Non-fatal: failed to persist baseline", { err });
  }
}

export interface AuditedIntegration extends IntegrationAuditResult {
  /** True on the first run this integration was ever observed. */
  newlyObserved: boolean;
  /** Days since the first observation (0 on the run that first observes it). */
  observedForDays: number;
}

export interface ApiScopeAuditReport {
  generatedAt: string;
  minObservationDays: number;
  integrations: AuditedIntegration[];
  flaggedScopeCount: number;
}

/**
 * Applies the sustained-observation guard: an integration younger than the
 * minimum observation window is reported (so operators can see it's being
 * tracked) but never flagged as over-provisioned yet.
 */
function withObservationGuard(
  result: IntegrationAuditResult,
  newlyObserved: boolean,
  observedForDays: number,
  minObservationDays: number
): AuditedIntegration {
  const sustained = !newlyObserved && observedForDays >= minObservationDays;
  if (sustained) {
    return { ...result, newlyObserved, observedForDays };
  }
  return {
    ...result,
    findings: result.findings.map((f) => ({ ...f, overProvisioned: false })),
    overProvisionedScopes: [],
    newlyObserved,
    observedForDays,
  };
}

export async function runApiKeyScopeAuditJob(
  overrides: {
    getUsage?: (integration: string) => Promise<Record<string, CapabilityUsageInfo>>;
    recipients?: string[];
    baselineFile?: string;
    now?: () => Date;
    integrations?: ApiIntegrationDefinition[];
  } = {}
): Promise<{ report: ApiScopeAuditReport; emailed: number }> {
  const now = overrides.now ? overrides.now() : new Date();
  const baselineFile = overrides.baselineFile ?? baselinePath();
  const baseline = await loadBaseline(baselineFile);
  const getUsage = overrides.getUsage ?? getUsageForIntegration;
  const definitions = overrides.integrations ?? API_INTEGRATIONS;

  const integrations: AuditedIntegration[] = [];
  const nextBaseline: AuditBaseline = { ...baseline };

  for (const def of definitions) {
    if (!def.isConfigured(process.env)) continue;

    const firstObserved = baseline[def.integration];
    const newlyObserved = !firstObserved;
    if (newlyObserved) {
      nextBaseline[def.integration] = now.toISOString();
    }
    const observedForDays = newlyObserved
      ? 0
      : Math.floor((now.getTime() - new Date(firstObserved).getTime()) / 86_400_000);

    const grantedScopes = resolveGrantedScopes(def);

    if (def.auditable === false) {
      // Inventoried for the doc/report, never scope-compared.
      integrations.push({
        integration: def.integration,
        displayName: def.displayName,
        grantedScopes,
        minimumRequiredScopes: Array.from(new Set(Object.values(def.capabilityScopes))).sort(),
        findings: [],
        overProvisionedScopes: [],
        newlyObserved,
        observedForDays,
      });
      continue;
    }

    const usage = await getUsage(def.integration);
    const result = auditIntegration(def, grantedScopes, usage);
    integrations.push(
      withObservationGuard(result, newlyObserved, observedForDays, API_KEY_SCOPE_AUDIT_MIN_OBSERVATION_DAYS)
    );
  }

  await saveBaseline(nextBaseline, baselineFile);

  const flaggedScopeCount = integrations.reduce((sum, i) => sum + i.overProvisionedScopes.length, 0);
  const report: ApiScopeAuditReport = {
    generatedAt: now.toISOString(),
    minObservationDays: API_KEY_SCOPE_AUDIT_MIN_OBSERVATION_DAYS,
    integrations,
    flaggedScopeCount,
  };

  const config = loadConfig();
  const recipients =
    overrides.recipients ??
    String(process.env.API_KEY_SCOPE_AUDIT_DIGEST_RECIPIENTS ?? config.complianceAlertEmail ?? "")
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);

  let emailed = 0;
  if (flaggedScopeCount > 0 && recipients.length > 0) {
    const html = buildReportHtml(report);
    const subject = `RemitMortgage — API Key Scope Audit (${flaggedScopeCount} over-provisioned scope(s))`;
    for (const to of recipients) {
      try {
        if (await sendEmail(to, subject, html)) emailed += 1;
      } catch (err) {
        logger.warn("[api-scope-audit] Failed to email report", { to, err });
      }
    }
  } else {
    logger.info(
      `[api-scope-audit] Audited ${integrations.length} integration(s), ${flaggedScopeCount} over-provisioned scope(s); ` +
        (recipients.length === 0 ? "no recipients configured, skipping email." : "nothing to report.")
    );
  }

  try {
    await (prisma as any).auditLog?.create?.({
      data: {
        action: "API_KEY_SCOPE_AUDIT_REPORT",
        actorAddress: "system:scheduler",
        metadata: {
          generatedAt: report.generatedAt,
          flaggedScopeCount,
          integrations: integrations.map((i) => ({
            integration: i.integration,
            grantedScopes: i.grantedScopes,
            overProvisionedScopes: i.overProvisionedScopes,
            newlyObserved: i.newlyObserved,
          })),
        },
      },
    });
  } catch (err) {
    logger.warn("[api-scope-audit] Non-blocking failure persisting audit log entry", { err });
  }

  return { report, emailed };
}

export function buildReportHtml(report: ApiScopeAuditReport): string {
  const rows =
    report.integrations
      .flatMap((i) =>
        i.overProvisionedScopes.map(
          (scope) => `
      <tr>
        <td class="details-value"><code>${i.displayName}</code></td>
        <td class="details-value"><code>${scope}</code></td>
        <td class="details-value">${i.minimumRequiredScopes.join(", ") || "—"}</td>
      </tr>`
        )
      )
      .join("\n") ||
    `<tr><td colspan="3" class="details-value">No over-provisioned scopes this run.</td></tr>`;

  return getBrandedHtml(
    "RemitMortgage — API Key Scope Audit",
    `
    <h2>Over-Provisioned API Key Scopes</h2>
    <p><strong>${report.flaggedScopeCount}</strong> granted scope(s) across
    <strong>${report.integrations.length}</strong> audited integration(s) have never been
    exercised by the backend's actual usage (${report.minObservationDays}d minimum
    observation window before a scope can be flagged).</p>
    <table class="details-table">
      <tr>
        <td class="details-label"><strong>Integration</strong></td>
        <td class="details-label"><strong>Unused granted scope</strong></td>
        <td class="details-label"><strong>Minimum required scopes</strong></td>
      </tr>
      ${rows}
    </table>
    <p style="margin-top:16px;font-size:13px;color:#64748b;">
      This report never revokes or modifies a credential — reduce scope
      manually via each provider's console/API, then confirm the integration
      still works end to end. See <code>docs/API_KEY_SCOPE_AUDIT.md</code>
      for the per-integration minimum-scope reference and review process.
    </p>`
  );
}
