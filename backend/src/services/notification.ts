// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { prisma, getNotificationPreference } from "./db.js";
import logger from "../utils/logger.js";
import { sendEmail, sendDepositReceipt, sendRepaymentReminder, sendLoanStatusUpdate } from "./email.js";
import { sendWebhook } from "./webhook.js";
import { queueService } from "./queueService.js";
import { getCurrentTenant } from "./tenant.js";

export type NotificationType = "EMAIL" | "WEBHOOK" | "SMS";

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 60 * 1000; // 1 minute base backoff

/**
 * Resolves "now" in a given IANA timezone as wall-clock components, plus a
 * `Date` whose UTC fields *are* those local wall-clock values (a convenient
 * trick for doing day/hour arithmetic without a full timezone library —
 * `setUTCHours`/`setUTCDate` on this Date operate on local wall-clock time).
 */
function resolveLocalWallClock(tz: string): { localDate: Date; currentMinutes: number; currentDay: number } | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric'
    });

    const parts = formatter.formatToParts(new Date());
    const getPart = (type: string) => parts.find(p => p.type === type)?.value || "";

    const currentHour = parseInt(getPart("hour"));
    const currentMin = parseInt(getPart("minute"));

    const localDate = new Date(Date.UTC(
      parseInt(getPart("year")),
      parseInt(getPart("month")) - 1,
      parseInt(getPart("day")),
      currentHour,
      currentMin,
      parseInt(getPart("second"))
    ));

    return {
      localDate,
      currentMinutes: currentHour * 60 + currentMin,
      currentDay: localDate.getUTCDay(), // 0-6, Sunday-Saturday
    };
  } catch (e) {
    logger.warn(`Failed to resolve local time for tz ${tz}`, e);
    return null;
  }
}

/**
 * Computes milliseconds until the next business hour start time.
 */
function computeBusinessHoursDelay(preferences: any, isUrgent: boolean): number {
  if (isUrgent || !preferences || !preferences.timezone) return 0;

  const tz = preferences.timezone || "UTC";
  const startHourStr = preferences.startHour || "09:00";
  const endHourStr = preferences.endHour || "17:00";
  const businessDaysStr = preferences.businessDays || "1,2,3,4,5";
  const businessDays = businessDaysStr.split(',').map(Number);

  const wallClock = resolveLocalWallClock(tz);
  if (!wallClock) return 0;
  const { localDate, currentMinutes, currentDay } = wallClock;

  const startH = parseInt(startHourStr.split(':')[0]);
  const startM = parseInt(startHourStr.split(':')[1] || "0");
  const endH = parseInt(endHourStr.split(':')[0]);
  const endM = parseInt(endHourStr.split(':')[1] || "0");

  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  const isBusinessDay = businessDays.includes(currentDay);
  const isBusinessHours = currentMinutes >= startMinutes && currentMinutes < endMinutes;

  if (isBusinessDay && isBusinessHours) {
    return 0;
  }

  let daysToAdd = 0;
  if (!isBusinessDay || currentMinutes >= endMinutes) {
    daysToAdd = 1;
    while (!businessDays.includes((currentDay + daysToAdd) % 7)) {
      daysToAdd++;
    }
  }

  const targetTime = new Date(localDate);
  targetTime.setUTCDate(localDate.getUTCDate() + daysToAdd);
  targetTime.setUTCHours(startH, startM, 0, 0);

  const diffMs = targetTime.getTime() - localDate.getTime();
  return diffMs > 0 ? diffMs : 0;
}

/**
 * Computes milliseconds until the next digest delivery window for a
 * DAILY_DIGEST or WEEKLY_DIGEST preference. Reuses the same `timezone` and
 * `startHour` fields as the business-hours throttle above, rather than
 * adding new columns: "daily digest" means "once a day, at the hour you
 * configured as your business-hours start"; "weekly digest" means "once a
 * week, same hour, on Monday". IMMEDIATE always returns 0 and is handled by
 * the caller before this is reached.
 */
function computeDigestDelay(preferences: any, frequency: NotificationFrequency): number {
  if (frequency === "IMMEDIATE" || !preferences) return 0;

  const tz = preferences.timezone || "UTC";
  const digestHourStr = preferences.startHour || "09:00";
  const digestH = parseInt(digestHourStr.split(':')[0]);
  const digestM = parseInt(digestHourStr.split(':')[1] || "0");
  const digestMinutes = digestH * 60 + digestM;

  const wallClock = resolveLocalWallClock(tz);
  if (!wallClock) return 0;
  const { localDate, currentMinutes, currentDay } = wallClock;

  let daysToAdd: number;
  if (frequency === "DAILY_DIGEST") {
    daysToAdd = currentMinutes < digestMinutes ? 0 : 1;
  } else {
    // WEEKLY_DIGEST: next Monday (day 1) at the digest hour.
    const MONDAY = 1;
    daysToAdd = (MONDAY - currentDay + 7) % 7;
    if (daysToAdd === 0 && currentMinutes >= digestMinutes) daysToAdd = 7;
  }

  const targetTime = new Date(localDate);
  targetTime.setUTCDate(localDate.getUTCDate() + daysToAdd);
  targetTime.setUTCHours(digestH, digestM, 0, 0);

  const diffMs = targetTime.getTime() - localDate.getTime();
  return diffMs > 0 ? diffMs : 0;
}

/**
 * Queues a notification in the Postgres database and dispatches via BullMQ.
 */
export async function queueNotification(
  recipient: string,
  type: NotificationType,
  content: string,
  delayMs: number = 0
) {
  const createData: any = {
    recipient,
    type,
    content,
    status: "Pending",
    attempts: 0,
  };
  if (delayMs > 0) {
    createData.nextRetryAt = new Date(Date.now() + delayMs);
  }

  const notification = await prisma.notification.create({ data: createData });

  // Dispatch via BullMQ queue (load-balanced across workers)
  await queueService.addNotificationJob({
    notificationId: notification.id,
    recipient,
    type,
    content,
    tenantId: getCurrentTenant().id,
  }, {
    attempts: MAX_ATTEMPTS,
    backoff: { type: "exponential", delay: BASE_BACKOFF_MS },
    delay: delayMs > 0 ? delayMs : undefined,
  });

  return notification;
}

/**
 * Dispatches a single notification. Handles success, failure, and schedules retries.
 */
export async function dispatchNotification(id: string): Promise<boolean> {
  const notification = await prisma.notification.findUnique({
    where: { id },
  });

  if (!notification) {
    logger.error(`[NotificationService] Notification ${id} not found`);
    return false;
  }

  // Only dispatch if Pending or Failed (eligible for retry)
  if (notification.status !== "Pending" && notification.status !== "Failed") {
    return false;
  }

  const currentAttempts = notification.attempts + 1;
  let success = false;
  let errorMsg = "";
  
  let dlqWebhookData: any = null;

  try {
    if (notification.type === "EMAIL") {
      success = await handleEmailDispatch(notification.recipient, notification.content);
    } else if (notification.type === "SMS") {
      success = await handleSmsDispatch(notification.recipient, notification.content);
    } else if (notification.type === "WEBHOOK") {
      let payload = {};
      try {
        payload = JSON.parse(notification.content);
      } catch {
        payload = { message: notification.content };
      }
      const webhookResult = await sendWebhook(notification.recipient, payload);
      success = webhookResult.success;
      
      if (!success) {
        errorMsg = webhookResult.error || `HTTP ${webhookResult.status}: ${webhookResult.responsePayload?.slice(0, 200)}`;
        dlqWebhookData = {
          url: notification.recipient,
          payload,
          statusCode: webhookResult.status,
          responsePayload: webhookResult.responsePayload,
          error: webhookResult.error
        };
      }
    } else {
      throw new Error(`Unsupported notification type: ${notification.type}`);
    }

    if (!success && !errorMsg) {
      errorMsg = "Service dispatch returned false";
    }
  } catch (err: any) {
    success = false;
    errorMsg = err.message || String(err);
  }

  if (success) {
    await prisma.notification.update({
      where: { id },
      data: {
        status: "Sent",
        attempts: currentAttempts,
        lastError: null,
        nextRetryAt: null,
      },
    });
    return true;
  } else {
    // Determine retry parameters using exponential backoff
    const hasMoreRetries = currentAttempts < MAX_ATTEMPTS;
    const backoffDelay = BASE_BACKOFF_MS * Math.pow(2, currentAttempts - 1);
    const nextRetryAt = hasMoreRetries ? new Date(Date.now() + backoffDelay) : null;
    const finalStatus = "Failed"; // Keep status as Failed so it can be retried or audited

    await prisma.notification.update({
      where: { id },
      data: {
        status: finalStatus,
        attempts: currentAttempts,
        lastError: errorMsg,
        nextRetryAt,
      },
    });
    
    if (!hasMoreRetries && notification.type === "WEBHOOK" && dlqWebhookData) {
      try {
        await prisma.webhookDLQ.create({
          data: {
            url: dlqWebhookData.url,
            payload: dlqWebhookData.payload,
            statusCode: dlqWebhookData.statusCode,
            responsePayload: dlqWebhookData.responsePayload,
            error: dlqWebhookData.error,
          }
        });
        logger.info(`[NotificationService] Webhook DLQ record created for notification ${id}`);
      } catch (dlqErr) {
        logger.error(`[NotificationService] Failed to create DLQ record for ${id}`, { err: dlqErr });
      }
    }

    logger.warn(
      `[NotificationService] Notification ${id} failed (attempt ${currentAttempts}/${MAX_ATTEMPTS}). Next retry at: ${nextRetryAt}`
    );
    return false;
  }
}

/**
 * Internal helper to dispatch SMS messages.
 */
async function handleSmsDispatch(recipient: string, content: string): Promise<boolean> {
  logger.info(`[SMS Dispatcher] Sending SMS to ${recipient}: "${content}"`);
  // Simulated SMS provider integration (e.g. Twilio / MessageBird)
  return true;
}

/**
 * Internal helper to send correct email format depending on whether content is JSON-structured.
 */
async function handleEmailDispatch(recipient: string, content: string): Promise<boolean> {
  // Check if content is structured JSON (i.e. to send template emails)
  if (content.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(content);
      if (parsed.template === "deposit_receipt") {
        return await sendDepositReceipt(recipient, parsed.amount, parsed.transactionId);
      }
      if (parsed.template === "repayment_reminder") {
        return await sendRepaymentReminder(recipient, parsed.amount, parsed.dueDate);
      }
      if (parsed.template === "loan_status_update") {
        return await sendLoanStatusUpdate(recipient, parsed.loanId, parsed.status);
      }
    } catch {
      // Fallback if JSON parsing fails
    }
  }

  // Fallback: send as general styled email
  return await sendEmail(recipient, "Notification Alert - RemitMortgage", content);
}

/**
 * Evaluates dynamic escrow maturity & missed payment triggers and dispatches alerts according to user preferences.
 */
export type MaturityAlertEventType =
  | "ESCROW_APPROACHING"
  | "ESCROW_REACHED"
  | "PAYMENT_MISSED"
  | "MILESTONE_UPDATE"
  | "GOVERNANCE_PROPOSAL"
  | "SECURITY_ALERT";

/**
 * Maps each event type to the NotificationPreference field governing its
 * delivery cadence. SECURITY_ALERT is intentionally absent — it never
 * consults a stored frequency (see the `isSecurity` branch below), so there
 * is no key here that could be mistakenly wired up to make it configurable.
 */
const FREQUENCY_FIELD_BY_EVENT: Partial<
  Record<MaturityAlertEventType, "depositsFrequency" | "milestonesFrequency" | "governanceFrequency">
> = {
  ESCROW_APPROACHING: "depositsFrequency",
  ESCROW_REACHED: "depositsFrequency",
  MILESTONE_UPDATE: "milestonesFrequency",
  GOVERNANCE_PROPOSAL: "governanceFrequency",
};

export async function dispatchMaturityAlerts(
  applicantAddress: string,
  event: {
    type: MaturityAlertEventType;
    progress?: number;
    deposited?: string;
    target?: string;
    milestoneName?: string;
    message?: string;
  }
) {
  const preferences = await getNotificationPreference(applicantAddress);
  if (!preferences) {
    logger.info(`[NotificationService] No notification preferences found for ${applicantAddress}`);
    return;
  }

  const {
    email,
    phone,
    emailAlerts,
    smsAlerts,
    escrowApproaching,
    escrowReached,
    paymentMissed,
    loanMilestones,
    governanceAlerts,
    webhookUrl,
  } = preferences;

  let shouldSend = false;
  let subject = "RemitMortgage Alert";
  let text = event.message || "";

  let isUrgent = false;
  // Security-critical alerts (new-device login, etc.) are never gated by a
  // user preference and never deferred — this is the one non-negotiable
  // exception the settings UI must make clear to users.
  const isSecurity = event.type === "SECURITY_ALERT";

  switch (event.type) {
    case "ESCROW_APPROACHING":
      shouldSend = Boolean(escrowApproaching);
      subject = "⚡ Escrow Target Approaching!";
      text = text || `You have reached ${event.progress}% of your escrow down payment goal ($${event.deposited} / $${event.target} USDC). Keep going!`;
      break;
    case "ESCROW_REACHED":
      shouldSend = Boolean(escrowReached);
      subject = "🎉 Down Payment Target Reached!";
      text = text || `Congratulations! You have completed 100% of your 30% down payment target ($${event.deposited} USDC). You are now eligible to apply for property financing!`;
      break;
    case "PAYMENT_MISSED":
      shouldSend = Boolean(paymentMissed);
      isUrgent = true;
      subject = "⚠️ Missed Payment Alert";
      text = text || "A payment on your RemitMortgage schedule was missed. Please review your account to stay on track and avoid late fees.";
      break;
    case "MILESTONE_UPDATE":
      shouldSend = Boolean(loanMilestones);
      subject = "🏗️ Construction Milestone Update";
      text = text || `Milestone update: ${event.milestoneName || "Construction phase"} has been updated on IPFS & Soroban multisig.`;
      break;
    case "GOVERNANCE_PROPOSAL":
      shouldSend = Boolean(governanceAlerts);
      subject = "🗳️ New Governance Proposal";
      text = text || "A new protocol governance proposal is open for voting.";
      break;
    case "SECURITY_ALERT":
      // Always sent — security alerts cannot be disabled, unlike every
      // other category above.
      shouldSend = true;
      isUrgent = true;
      subject = "🔒 Security Alert";
      text = text || "A new sign-in or other security-sensitive action was detected on your account. If this wasn't you, secure your account immediately.";
      break;
  }

  if (!shouldSend) {
    logger.info(`[NotificationService] Alert ${event.type} disabled by user settings for ${applicantAddress}`);
    return;
  }

  // Frequency-based deferral only applies to categories with a mapped
  // preference field, and never to security alerts or already-urgent events
  // — those always deliver with delayMs = 0 via computeBusinessHoursDelay's
  // own isUrgent short-circuit.
  const frequencyField = FREQUENCY_FIELD_BY_EVENT[event.type];
  const frequency: NotificationFrequency = isSecurity
    ? "IMMEDIATE"
    : ((frequencyField ? (preferences as any)[frequencyField] : undefined) ?? "IMMEDIATE");

  const delayMs =
    isUrgent || isSecurity
      ? 0
      : frequency === "IMMEDIATE"
        ? computeBusinessHoursDelay(preferences, isUrgent)
        : computeDigestDelay(preferences, frequency);

  // Note: the emailAlerts/smsAlerts channel toggles below still apply even to
  // security alerts — "always immediate" governs *timing*, not whether the
  // user has that delivery channel switched on at all.
  const dispatches: Promise<any>[] = [];

  if (emailAlerts && email) {
    dispatches.push(queueNotification(email, "EMAIL", `${subject}: ${text}`, delayMs));
  }

  if (smsAlerts && phone) {
    dispatches.push(queueNotification(phone, "SMS", `${subject}: ${text}`, delayMs));
  }

  if (webhookUrl) {
    const payload = JSON.stringify({ event: event.type, subject, message: text, address: applicantAddress });
    dispatches.push(queueNotification(webhookUrl, "WEBHOOK", payload, delayMs));
  }

  await Promise.allSettled(dispatches);
}

/**
 * Runs a batch dispatch of all failed/pending notifications that are due for retry.
 */
export async function processRetries(): Promise<number> {
  const now = new Date();
  const dueNotifications = await prisma.notification.findMany({
    where: {
      status: "Failed",
      nextRetryAt: {
        lte: now,
      },
      attempts: {
        lt: MAX_ATTEMPTS,
      },
    },
  });

  let processedCount = 0;
  for (const notification of dueNotifications) {
    const success = await dispatchNotification(notification.id);
    if (success) {
      processedCount++;
    }
  }

  return processedCount;
}

/**
 * @deprecated BullMQ workers now handle retry scheduling.
 * Kept as a no-op for backward compatibility.
 */
let pollingInterval: NodeJS.Timeout | null = null;
export function startNotificationScheduler(_intervalMs = 30000) {
  if (pollingInterval) return;
  logger.info("[NotificationScheduler] replaced by BullMQ notification worker; polling disabled");
  // Mark as started to prevent repeated warnings
  pollingInterval = { ref: () => {} } as unknown as NodeJS.Timeout;
}

export function stopNotificationScheduler() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

