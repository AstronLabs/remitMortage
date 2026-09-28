// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Scheduled wrapper around the table bloat scan (issue #684). Runs the scan,
 * logs a summary, and alerts ops when any table required a manual VACUUM.
 */

import { runTableBloatScan, type TableBloatScanResult } from "../services/tableBloatMonitor.js";
import { loadConfig } from "../config.js";
import { sendEmail, getBrandedHtml } from "../services/email.js";
import { sendWebhook } from "../services/webhook.js";
import logger from "../utils/logger.js";

function formatRatio(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

async function alertOnCriticalBloat(result: TableBloatScanResult): Promise<void> {
  const critical = result.findings.filter((f) => f.level === "critical");
  if (critical.length === 0) return;

  const config = loadConfig();
  const rows = critical
    .map(
      (f) =>
        `<tr><td class="details-label">${f.schemaName}.${f.tableName}</td><td class="details-value">${formatRatio(f.deadTupleRatio)}</td><td class="details-value">${f.deadTuples}</td><td class="details-value">${f.vacuumTriggered ? "VACUUMed" : "VACUUM failed"}</td></tr>`
    )
    .join("\n");

  const html = getBrandedHtml(
    "RemitMortgage — Table Bloat Alert",
    `
    <h2>Table Bloat Monitor</h2>
    <p><strong>${critical.length}</strong> table(s) crossed the critical dead-tuple threshold and were manually VACUUMed.</p>
    <table class="details-table">
      <tr><td class="details-label"><strong>Table</strong></td><td class="details-value"><strong>Dead ratio</strong></td><td class="details-value"><strong>Dead tuples</strong></td><td class="details-value"><strong>Action</strong></td></tr>
      ${rows}
    </table>
    `
  );

  const targetEmail = config.opsFallbackAlertEmail;
  if (targetEmail) {
    try {
      await sendEmail(targetEmail, `Table Bloat Alert: ${critical.length} table(s) VACUUMed`, html);
    } catch (error) {
      logger.error("[table-bloat-monitor] Failed to send email alert", { error });
    }
  }

  const webhookUrl = config.opsSlackWebhookUrl || config.alertWebhookUrl;
  if (webhookUrl) {
    const text = [
      `:elephant: *Table Bloat Monitor*`,
      `${critical.length} table(s) crossed the critical bloat threshold:`,
      ...critical.map(
        (f) => `• ${f.schemaName}.${f.tableName} — ${formatRatio(f.deadTupleRatio)} dead (${f.deadTuples} tuples), ${f.vacuumTriggered ? "VACUUMed" : "VACUUM failed"}`
      ),
    ].join("\n");
    try {
      await sendWebhook(webhookUrl, { text });
    } catch (error) {
      logger.error("[table-bloat-monitor] Failed to send Slack alert", { error });
    }
  }
}

export async function runTableBloatMonitorJob(): Promise<TableBloatScanResult> {
  logger.info("[table-bloat-monitor] Scanning for table bloat...");
  const result = await runTableBloatScan();

  const warned = result.findings.filter((f) => f.level === "warn").length;
  const critical = result.findings.filter((f) => f.level === "critical").length;
  logger.info(
    `[table-bloat-monitor] Scanned ${result.tablesScanned} tables: ${warned} warned, ${critical} critical (VACUUMed)`
  );

  await alertOnCriticalBloat(result);

  return result;
}
