import { runForeignKeyAudit, ForeignKeyAuditReport } from "../services/foreignKeyAudit.js";
import { loadConfig } from "../config.js";
import { sendEmail, getBrandedHtml } from "../services/email.js";
import { sendWebhook } from "../services/webhook.js";
import { prisma } from "../services/db.js";
import logger from "../utils/logger.js";

/**
 * Dispatches the audit report findings to compliance and operations channels.
 * Crucially, no automatic deletion is performed — findings are presented for human review.
 */
export async function dispatchComplianceOpsAlert(report: ForeignKeyAuditReport): Promise<void> {
  const config = loadConfig();

  const orphanRowsSummary = report.orphans
    .map(
      (o) =>
        `• <strong>${o.childTable}.${o.childColumn}</strong> &rarr; <strong>${o.parentTable}.${o.parentColumn}</strong>: ${o.orphanCount} orphaned row(s) [${o.type}] (Sample IDs: <code>${o.sampleOrphanIds.slice(0, 3).join(", ") || "none"}</code>)`
    )
    .join("<br/>");

  const missingConstraintsSummary = report.missingConstraints
    .map(
      (m) =>
        `• <strong>${m.childTable}.${m.childColumn}</strong> &rarr; <strong>${m.parentTable}.${m.parentColumn}</strong>: [${m.status}] ${m.description}`
    )
    .join("<br/>");

  const emailHtml = getBrandedHtml(
    "Compliance & Ops Alert: Database Foreign Key Integrity Audit",
    `
    <h2>⚠️ Referential Integrity Audit Alert</h2>
    <p>A scheduled foreign key constraint audit has detected potential data integrity gaps or orphaned records in the database.</p>
    
    <div style="background-color: #fef2f2; border: 1px solid #fecaca; padding: 15px; border-radius: 6px; margin: 15px 0;">
      <h3 style="color: #991b1b; margin-top: 0;">Audit Findings Overview</h3>
      <p style="color: #7f1d1d; margin-bottom: 5px;"><strong>Total Orphaned Rows:</strong> ${report.totalOrphanCount}</p>
      <p style="color: #7f1d1d; margin-bottom: 5px;"><strong>Missing/Unenforced FK Constraints:</strong> ${report.totalMissingConstraintCount}</p>
      <p style="color: #7f1d1d; margin-bottom: 0;"><strong>Policy Notice:</strong> No automated deletions were performed. Manual compliance review is required.</p>
    </div>

    ${
      report.orphans.length > 0
        ? `
      <h3>Orphaned Records Detected</h3>
      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; padding: 12px; border-radius: 6px; font-size: 13px; line-height: 1.6;">
        ${orphanRowsSummary}
      </div>
      `
        : ""
    }

    ${
      report.missingConstraints.length > 0
        ? `
      <h3>Missing Database Foreign Key Constraints</h3>
      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; padding: 12px; border-radius: 6px; font-size: 13px; line-height: 1.6;">
        ${missingConstraintsSummary}
      </div>
      `
        : ""
    }

    <p style="margin-top: 20px; font-size: 13px; color: #64748b;">
      Please inspect these relations and run reconciling migrations or review data consistency through standard operator procedures.
    </p>
    `
  );

  const subject = `⚠️ [Compliance/Ops] Foreign Key Audit: ${report.totalOrphanCount} orphan(s), ${report.totalMissingConstraintCount} missing constraint(s)`;

  // 1. Email Alert to Compliance / Ops
  const targetEmail = config.complianceAlertEmail || config.opsFallbackAlertEmail;
  if (targetEmail) {
    try {
      await sendEmail(targetEmail, subject, emailHtml);
      logger.info(`[foreignKeyAuditJob] Dispatched audit findings email to ${targetEmail}`);
    } catch (err) {
      logger.error(`[foreignKeyAuditJob] Failed to dispatch email alert to ${targetEmail}`, { err });
    }
  }

  // 2. Slack / Discord Webhook Alert
  const webhookUrl =
    config.complianceSlackWebhookUrl || config.opsSlackWebhookUrl || config.alertWebhookUrl;

  if (webhookUrl) {
    const slackPayload = {
      text: `⚠️ *[Compliance/Ops DB Audit]* Found ${report.totalOrphanCount} orphaned row(s) and ${report.totalMissingConstraintCount} missing FK constraint(s). Human review required.`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "⚠️ Database Referential Integrity Audit Alert",
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Total Orphans:*\n\`${report.totalOrphanCount}\`` },
            {
              type: "mrkdwn",
              text: `*Missing Constraints:*\n\`${report.totalMissingConstraintCount}\``,
            },
            {
              type: "mrkdwn",
              text: `*Relations Scanned:*\n\`${report.relationsCheckedCount}\``,
            },
            {
              type: "mrkdwn",
              text: `*Action:*\n_Human Review Required (No auto-deletions)_`,
            },
          ],
        },
      ],
    };

    try {
      await sendWebhook(webhookUrl, slackPayload);
      logger.info("[foreignKeyAuditJob] Dispatched Slack webhook alert for audit findings");
    } catch (err) {
      logger.error("[foreignKeyAuditJob] Failed to dispatch Slack webhook alert", { err });
    }
  }

  // 3. Persist audit record in database for traceability if available
  try {
    if ((prisma as any).auditLog?.create) {
      await (prisma as any).auditLog.create({
        data: {
          action: "REFERENTIAL_INTEGRITY_AUDIT_FINDINGS",
          actorAddress: "system:scheduler",
          metadata: {
            timestamp: report.timestamp,
            totalOrphans: report.totalOrphanCount,
            totalMissingConstraints: report.totalMissingConstraintCount,
            orphans: report.orphans,
            missingConstraints: report.missingConstraints,
          },
        },
      });
    }
  } catch (err) {
    logger.warn("[foreignKeyAuditJob] Non-blocking failure persisting audit log entry", { err });
  }
}

/**
 * Scheduled job executing the Foreign Key Constraint and Referential Integrity Audit.
 * Reports all findings to compliance/ops channels without modifying or deleting data.
 */
export async function runForeignKeyConstraintAuditJob(
  options = {}
): Promise<ForeignKeyAuditReport> {
  logger.info("[foreignKeyAuditJob] Triggering periodic referential integrity audit sweep...");

  const report = await runForeignKeyAudit(options);

  if (report.status === "ISSUES_DETECTED") {
    logger.warn("[foreignKeyAuditJob] Referential integrity issues detected. Alerting compliance/ops...", {
      orphans: report.totalOrphanCount,
      missingConstraints: report.totalMissingConstraintCount,
    });
    await dispatchComplianceOpsAlert(report);
  } else {
    logger.info("[foreignKeyAuditJob] Referential integrity audit clean. No orphans or missing constraints detected.");
  }

  return report;
}
