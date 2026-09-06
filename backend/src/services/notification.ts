import { prisma, getNotificationPreference } from "./db.js";
import logger from "../utils/logger.js";
import { sendEmail, sendDepositReceipt, sendRepaymentReminder, sendLoanStatusUpdate } from "./email.js";
import { sendWebhook } from "./webhook.js";
import { queueService } from "./queueService.js";

export type NotificationType = "EMAIL" | "WEBHOOK" | "SMS";

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 60 * 1000; // 1 minute base backoff

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
  
  const now = new Date();
  
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
    
    const parts = formatter.formatToParts(now);
    const getPart = (type: string) => parts.find(p => p.type === type)?.value || "";
    
    const currentHour = parseInt(getPart("hour"));
    const currentMin = parseInt(getPart("minute"));
    const startH = parseInt(startHourStr.split(':')[0]);
    const startM = parseInt(startHourStr.split(':')[1] || "0");
    const endH = parseInt(endHourStr.split(':')[0]);
    const endM = parseInt(endHourStr.split(':')[1] || "0");
    
    const localDate = new Date(Date.UTC(
      parseInt(getPart("year")),
      parseInt(getPart("month")) - 1,
      parseInt(getPart("day")),
      currentHour,
      currentMin,
      parseInt(getPart("second"))
    ));
    const currentDay = localDate.getUTCDay(); // 0-6
    
    const currentMinutes = currentHour * 60 + currentMin;
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
  } catch (e) {
    logger.warn(`Failed to compute business hours for tz ${tz}`, e);
    return 0;
  }
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
export async function dispatchMaturityAlerts(
  applicantAddress: string,
  event: {
    type: "ESCROW_APPROACHING" | "ESCROW_REACHED" | "PAYMENT_MISSED" | "MILESTONE_UPDATE";
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
    webhookUrl,
  } = preferences;

  let shouldSend = false;
  let subject = "RemitMortgage Alert";
  let text = event.message || "";

  let isUrgent = false;

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
  }

  if (!shouldSend) {
    logger.info(`[NotificationService] Alert ${event.type} disabled by user settings for ${applicantAddress}`);
    return;
  }

  const delayMs = computeBusinessHoursDelay(preferences, isUrgent);
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

