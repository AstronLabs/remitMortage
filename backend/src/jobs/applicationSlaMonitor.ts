import { prisma } from "../services/db.js";
import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";
import { sendEmail } from "../services/email.js";
import { sendWebhook } from "../services/webhook.js";

/**
 * Scans for loan applications sitting in a pending state past their configured SLA threshold window.
 * Dispatches email/Slack alerts to the assigned reviewer and fallback ops channel.
 */
export async function runApplicationSlaMonitorJob(): Promise<{ scannedCount: number; breachedCount: number }> {
  const config = loadConfig();
  const slaConfig = config.applicationSlaHours;
  const pendingStatuses = Object.keys(slaConfig).filter(
    (status) => status === "Pending" || status === "Disbursing"
  );

  logger.info(`[SLA Monitor] Starting SLA breach scan for statuses: ${pendingStatuses.join(", ")}`);

  // Query all applications in a pending state
  const pendingApplications = await prisma.loanApplication.findMany({
    where: {
      status: {
        in: pendingStatuses as any,
      },
    },
    include: {
      applicant: true,
    },
  });

  const now = new Date();
  let breachedCount = 0;

  for (const app of pendingApplications) {
    const statusTime = app.statusUpdatedAt || app.createdAt;
    const elapsedMs = now.getTime() - new Date(statusTime).getTime();
    const elapsedHours = elapsedMs / (1000 * 60 * 60);

    const thresholdHours = slaConfig[app.status] ?? 48;

    // Check if application breached SLA window and alert hasn't been sent for current status
    const hasBreached = elapsedHours >= thresholdHours;
    const alertAlreadySent =
      app.slaAlertSentAt && new Date(app.slaAlertSentAt).getTime() >= new Date(statusTime).getTime();

    if (hasBreached && !alertAlreadySent) {
      breachedCount++;
      logger.warn(
        `[SLA Monitor] Application ${app.id} stalled in '${app.status}' for ${elapsedHours.toFixed(
          1
        )}h (threshold: ${thresholdHours}h). Triggering alerts...`
      );

      const subject = `⚠️ [SLA Breach Alert] Loan Application Stalled (${app.id})`;
      const summaryText = `Loan application ${app.id} has been sitting in state '${app.status}' for ${elapsedHours.toFixed(
        1
      )} hours, exceeding the ${thresholdHours}-hour SLA window.`;

      const emailContent = `
        <h2>Loan Application SLA Breach Notice</h2>
        <p><strong>Application ID:</strong> ${app.id}</p>
        <p><strong>Status:</strong> ${app.status}</p>
        <p><strong>Principal:</strong> $${app.principal.toLocaleString()} USDC</p>
        <p><strong>Applicant Address:</strong> ${app.applicant?.stellarAddress || app.applicantId}</p>
        <p><strong>Time in Status:</strong> ${elapsedHours.toFixed(1)} hours (SLA Limit: ${thresholdHours}h)</p>
        <p><strong>Assigned Reviewer:</strong> ${app.assignedReviewerEmail || "Unassigned (Ops Default)"}</p>
        <hr/>
        <p>Please review and take action on this application immediately to meet compliance SLA standards.</p>
      `;

      // 1. Dispatch Email to Assigned Reviewer (if assigned)
      if (app.assignedReviewerEmail) {
        try {
          await sendEmail(app.assignedReviewerEmail, subject, emailContent);
          logger.info(`[SLA Monitor] Dispatched SLA alert email to reviewer ${app.assignedReviewerEmail}`);
        } catch (err) {
          logger.error(`[SLA Monitor] Failed to send email to reviewer ${app.assignedReviewerEmail}:`, { err });
        }
      }

      // 2. Dispatch Email to Fallback Ops Channel
      if (config.opsFallbackAlertEmail && config.opsFallbackAlertEmail !== app.assignedReviewerEmail) {
        try {
          await sendEmail(config.opsFallbackAlertEmail, subject, emailContent);
          logger.info(`[SLA Monitor] Dispatched SLA alert email to ops fallback ${config.opsFallbackAlertEmail}`);
        } catch (err) {
          logger.error(`[SLA Monitor] Failed to send email to ops fallback:`, { err });
        }
      }

      // 3. Dispatch Slack Webhook Alert
      if (config.opsSlackWebhookUrl) {
        const slackPayload = {
          text: `⚠️ *[SLA Breach Alert]* ${summaryText}`,
          blocks: [
            {
              type: "header",
              text: { type: "plain_text", text: "⚠️ SLA Breach Alert: Application Review Stalled" },
            },
            {
              type: "section",
              fields: [
                { type: "mrkdwn", text: `*Application ID:*\n\`${app.id}\`` },
                { type: "mrkdwn", text: `*Status:*\n\`${app.status}\`` },
                {
                  type: "mrkdwn",
                  text: `*Time Pending:*\n\`${elapsedHours.toFixed(1)} hrs\` (SLA: ${thresholdHours}h)`,
                },
                {
                  type: "mrkdwn",
                  text: `*Assigned Reviewer:*\n${app.assignedReviewerEmail || "_Unassigned_"}`,
                },
              ],
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `Applicant: \`${app.applicant?.stellarAddress || app.applicantId}\` | Principal: *$${app.principal.toLocaleString()} USDC*`,
                },
              ],
            },
          ],
        };

        try {
          await sendWebhook(config.opsSlackWebhookUrl, slackPayload);
          logger.info(`[SLA Monitor] Dispatched Slack SLA webhook alert`);
        } catch (err) {
          logger.error(`[SLA Monitor] Failed to send Slack SLA webhook alert:`, { err });
        }
      }

      // Record that alert has been sent for this application status cycle
      await prisma.loanApplication.update({
        where: { id: app.id },
        data: {
          slaAlertSentAt: now,
        },
      });
    }
  }

  logger.info(
    `[SLA Monitor] Completed scan. Scanned: ${pendingApplications.length}, Breaches Alerted: ${breachedCount}`
  );

  return { scannedCount: pendingApplications.length, breachedCount };
}
