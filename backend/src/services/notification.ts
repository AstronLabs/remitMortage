import { prisma } from "./db.js";
import logger from "../utils/logger.js";
import { sendEmail, sendDepositReceipt, sendRepaymentReminder, sendLoanStatusUpdate } from "./email.js";
import { sendWebhook } from "./webhook.js";
import { queueService } from "./queueService.js";

export type NotificationType = "EMAIL" | "WEBHOOK";

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 60 * 1000; // 1 minute base backoff

/**
 * Queues a notification in the Postgres database and dispatches via BullMQ.
 */
export async function queueNotification(
  recipient: string,
  type: NotificationType,
  content: string
) {
  const notification = await prisma.notification.create({
    data: {
      recipient,
      type,
      content,
      status: "Pending",
      attempts: 0,
    },
  });

  // Dispatch via BullMQ queue (load-balanced across workers)
  await queueService.addNotificationJob({
    notificationId: notification.id,
    recipient,
    type,
    content,
  }, {
    attempts: MAX_ATTEMPTS,
    backoff: { type: "exponential", delay: BASE_BACKOFF_MS },
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
 * Internal helper to send correct email format depending on whether content is JSON-structured.
 */
async function handleEmailDispatch(recipient: string, content: string): Promise<boolean> {
  // Check if content is structured JSON (i.e. to send template emails)
  if (content.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(content);
      const locale: string | undefined = parsed.locale;
      if (parsed.template === "deposit_receipt") {
        return await sendDepositReceipt(recipient, parsed.amount, parsed.transactionId, locale);
      }
      if (parsed.template === "repayment_reminder") {
        return await sendRepaymentReminder(recipient, parsed.amount, parsed.dueDate, locale);
      }
      if (parsed.template === "loan_status_update") {
        return await sendLoanStatusUpdate(recipient, parsed.loanId, parsed.status, locale);
      }
    } catch {
      // Fallback if JSON parsing fails
    }
  }

  // Fallback: send as general styled email
  return await sendEmail(recipient, "Notification Alert - RemitMortgage", content);
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
