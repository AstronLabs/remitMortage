// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Scheduled stale feature-flag cleanup audit (issue #754).
 *
 * Weekly report-only job: finds flags stuck at 100% (no variants) or 0% for
 * 30+ days, cross-references each against the codebase, and notifies the
 * owning team. Distinguishes:
 * - `stale-referenced` — still referenced in code, needs a cleanup PR;
 * - `stale-orphaned` — no longer referenced anywhere, removal is trivial.
 *
 * Hard guarantee: this job NEVER deletes flags or edits code. Removal follows
 * the human review workflow in `docs/STALE_FEATURE_FLAG_CLEANUP.md`.
 */

import { promises as fs } from "fs";
import path from "path";
import { FEATURE_FLAGS, STALE_FLAG_MIN_DAYS } from "../config/featureFlags.js";
import {
  findStaleFlagCandidates,
  type StaleFlagCandidate,
} from "../services/featureFlagAudit.js";
import { getBrandedHtml, sendEmail } from "../services/email.js";
import { createIssueNotifier, type IssueRecord } from "../services/issueNotifier.js";
import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";
import { prisma } from "../services/db.js";

export type FlagCodeStatus = "stale-referenced" | "stale-orphaned";

export interface FlagAuditEntry {
  flag: StaleFlagCandidate;
  codeStatus: FlagCodeStatus;
  references: string[];
}

const SEARCH_ROOTS = ["backend/src", "frontend/src", "contracts"];
const SKIP_DIRS = new Set(["node_modules", "target", ".git", "dist", "build"]);

async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (/\.(ts|tsx|js|mjs|cjs|rs|py|sh)$/.test(entry.name)) {
      yield full;
    }
  }
}

/**
 * Cross-reference a flag key against the codebase. Split out for testing —
 * pass a custom `readFile` in unit tests instead of touching disk.
 */
export async function findFlagReferences(
  flagKey: string,
  readFile: (file: string) => Promise<string> = (f) => fs.readFile(f, "utf8"),
  root = process.cwd()
): Promise<string[]> {
  const hits: string[] = [];
  for (const searchRoot of SEARCH_ROOTS) {
    for await (const file of walkFiles(path.join(root, searchRoot))) {
      try {
        const content = await readFile(file);
        if (content.includes(flagKey)) hits.push(path.relative(root, file));
      } catch {
        continue;
      }
    }
  }
  return hits;
}

export function buildFlagReportHtml(entries: FlagAuditEntry[]): string {
  const rows =
    entries
      .map(
        (e) => `
      <tr>
        <td class="details-value"><code>${e.flag.key}</code></td>
        <td class="details-value">${e.flag.kind} (${e.flag.rolloutPercent}%, ${e.flag.staleForDays}d)</td>
        <td class="details-value"><strong>${e.codeStatus}</strong> — ${e.references.length ? e.references.map((r) => `<code>${r}</code>`).join(", ") : "no references in code"}</td>
        <td class="details-value">${e.flag.owner}</td>
      </tr>`
      )
      .join("\n") ||
    `<tr><td colspan="4" class="details-value">No stale feature flags this run.</td></tr>`;

  return getBrandedHtml(
    "RemitMortgage — Stale Feature Flag Report",
    `
    <h2>Stale Feature Flag Candidates</h2>
    <p><strong>${entries.length}</strong> flag(s) at a terminal rollout for ${STALE_FLAG_MIN_DAYS}+ days.
    This report never deletes anything — see <code>docs/STALE_FEATURE_FLAG_CLEANUP.md</code>.</p>
    <table class="details-table">
      <tr>
        <td class="details-label"><strong>Flag</strong></td>
        <td class="details-label"><strong>State</strong></td>
        <td class="details-label"><strong>Code status</strong></td>
        <td class="details-label"><strong>Owner</strong></td>
      </tr>
      ${rows}
    </table>`
  );
}

export interface StaleFlagAuditResult {
  entries: FlagAuditEntry[];
  issuesOpened: number;
  emailed: number;
}

export async function runStaleFeatureFlagAuditJob(
  overrides: {
    now?: Date;
    minStaleDays?: number;
    findReferences?: (flagKey: string) => Promise<string[]>;
    recipients?: string[];
    issueSink?: { open: (issue: IssueRecord) => Promise<void> };
  } = {}
): Promise<StaleFlagAuditResult> {
  const candidates = findStaleFlagCandidates(FEATURE_FLAGS, {
    minStaleDays: overrides.minStaleDays ?? STALE_FLAG_MIN_DAYS,
    now: overrides.now,
  });

  const entries: FlagAuditEntry[] = [];
  for (const flag of candidates) {
    const references = overrides.findReferences
      ? await overrides.findReferences(flag.key)
      : await findFlagReferences(flag.key);
    entries.push({
      flag,
      codeStatus: references.length > 0 ? "stale-referenced" : "stale-orphaned",
      references,
    });
  }

  // One tracking issue (or notification) per stale flag — never auto-delete.
  const issueSink = overrides.issueSink ?? createIssueNotifier();
  let issuesOpened = 0;
  for (const entry of entries) {
    try {
      await issueSink.open({
        title: `[flag-cleanup] Stale flag: ${entry.flag.key} (${entry.codeStatus})`,
        body:
          `${entry.flag.reason}\nOwner: ${entry.flag.owner}\n` +
          `Code status: ${entry.codeStatus}\n` +
          (entry.references.length
            ? `References:\n- ${entry.references.join("\n- ")}\n`
            : `Not referenced anywhere in backend/src, frontend/src, or contracts — removal should be trivial.\n`) +
          `\nSee docs/STALE_FEATURE_FLAG_CLEANUP.md for the removal workflow.`,
        labels: ["flag-cleanup", entry.codeStatus, `owner:${entry.flag.owner}`],
      });
      issuesOpened += 1;
    } catch (err) {
      logger.warn("[stale-flag-audit] Failed to open tracking issue", { flag: entry.flag.key, err });
    }
  }

  const config = loadConfig();
  const recipients =
    overrides.recipients ??
    String(process.env.STALE_FLAG_DIGEST_RECIPIENTS ?? config.complianceAlertEmail ?? "")
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);

  let emailed = 0;
  if (entries.length > 0 && recipients.length > 0) {
    const html = buildFlagReportHtml(entries);
    const subject = `RemitMortgage — Stale Feature Flag Report (${entries.length} candidates)`;
    for (const to of recipients) {
      try {
        if (await sendEmail(to, subject, html)) emailed += 1;
      } catch (err) {
        logger.warn("[stale-flag-audit] Failed to email report", { to, err });
      }
    }
  } else {
    logger.info(
      `[stale-flag-audit] ${entries.length} stale candidates; ` +
        (recipients.length === 0 ? "no recipients configured, skipping email." : "nothing to report.")
    );
  }

  try {
    await (prisma as any).auditLog?.create?.({
      data: {
        action: "STALE_FEATURE_FLAG_AUDIT_REPORT",
        actorAddress: "system:scheduler",
        metadata: {
          generatedAt: new Date().toISOString(),
          entries: entries.map((e) => ({
            key: e.flag.key,
            kind: e.flag.kind,
            codeStatus: e.codeStatus,
            references: e.references,
          })),
        },
      },
    });
  } catch (err) {
    logger.warn("[stale-flag-audit] Non-blocking failure persisting audit log entry", { err });
  }

  return { entries, issuesOpened, emailed };
}
