import { Router, Request, Response } from "express";
import logger from "../utils/logger.js";
import {
  getNotificationPreference,
  upsertNotificationPreference,
  getUserInAppNotifications,
  markInAppNotificationRead,
  markAllInAppNotificationsRead,
  createInAppNotification,
} from "../services/db.js";
import { dispatchMaturityAlerts } from "../services/notification.js";

export const notificationsRouter = Router();

/**
 * GET /api/notifications
 * Fetch historical in-app notifications for a given wallet address.
 */
notificationsRouter.get("/", async (req: Request, res: Response) => {
  const address = (req.query.address || req.query.walletAddress || req.query.userId) as string;

  if (!address) {
    return res.status(400).json({ error: "Address or walletAddress query parameter is required." });
  }

  try {
    const notifications = await getUserInAppNotifications(address);
    // Support both the older `status` field and a boolean `read` flag used by tests.
    const unreadCount = notifications.filter((n: any) => (typeof n.read === 'boolean' ? !n.read : n.status !== "Sent")).length;

    return res.json({
      notifications,
      unreadCount,
    });
  } catch (error: any) {
    logger.error("[NotificationsRouter] Error fetching in-app notifications:", { error });
    return res.status(500).json({ error: "Failed to fetch in-app notifications." });
  }
});

/**
 * PATCH /api/notifications/:id/read
 * Mark a single in-app notification as read.
 */
notificationsRouter.patch("/:id/read", async (req: Request, res: Response) => {
  const { id } = req.params;
  const address = (req.body.address || req.body.walletAddress || req.query.address) as string;

  if (!address) {
    return res.status(400).json({ error: "Address or walletAddress is required." });
  }

  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    await markInAppNotificationRead(id, address);
    return res.json({ success: true, message: `Notification ${id} marked as read.` });
  } catch (error: any) {
    logger.error("[NotificationsRouter] Error marking notification read:", { id, error });
    return res.status(500).json({ error: "Failed to mark notification as read." });
  }
});

/**
 * POST /api/notifications/read-all
 * Mark all in-app notifications as read for a given wallet address.
 */
notificationsRouter.post("/read-all", async (req: Request, res: Response) => {
  const { address, walletAddress } = req.body;
  const targetAddress = address || walletAddress;

  if (!targetAddress) {
    return res.status(400).json({ error: "Address or walletAddress is required." });
  }

  try {
    await markAllInAppNotificationsRead(targetAddress);
    return res.json({ success: true, message: "All notifications marked as read." });
  } catch (error: any) {
    logger.error("[NotificationsRouter] Error marking all notifications read:", { address: targetAddress, error });
    return res.status(500).json({ error: "Failed to mark all notifications as read." });
  }
});

/**
 * POST /api/notifications/in-app
 * Ingest a new in-app notification.
 */
notificationsRouter.post("/in-app", async (req: Request, res: Response) => {
  const { address, walletAddress, title, message, variant, metadata } = req.body;
  const targetAddress = address || walletAddress;

  if (!targetAddress || !title) {
    return res.status(400).json({ error: "Address and title are required." });
  }

  try {
    const notification = await createInAppNotification({
      walletAddress: targetAddress,
      title,
      message,
      variant,
      metadata,
    });

    return res.json({ success: true, notification });
  } catch (error: any) {
    logger.error("[NotificationsRouter] Error creating in-app notification:", { error });
    return res.status(500).json({ error: "Failed to create in-app notification." });
  }
});

/**
 * GET /api/notifications/preferences
 * Fetch notification preferences for a user by address or applicantId.
 */
notificationsRouter.get("/preferences", async (req: Request, res: Response) => {
  const address = (req.query.address || req.query.userId) as string;

  if (!address) {
    return res.status(400).json({ error: "Address or userId query parameter is required." });
  }

  try {
    const preferences = await getNotificationPreference(address);
    return res.json({ preferences: preferences || null });
  } catch (error: any) {
    logger.error("[NotificationsRouter] Error fetching preferences:", { error });
    return res.status(500).json({ error: "Failed to fetch notification preferences." });
  }
});

/**
 * POST /api/notifications/preferences
 * Save notification preferences for a user in the database.
 */
notificationsRouter.post("/preferences", async (req: Request, res: Response) => {
  const { address, userId, email, phone, emailAlerts, smsAlerts, escrowApproaching, escrowReached, paymentMissed, loanMilestones, webhookUrl } = req.body;
  const targetId = address || userId;

  if (!targetId) {
    return res.status(400).json({ error: "Address or userId is required." });
  }

  try {
    const updated = await upsertNotificationPreference(targetId, {
      email,
      phone,
      emailAlerts: Boolean(emailAlerts),
      smsAlerts: Boolean(smsAlerts),
      escrowApproaching: Boolean(escrowApproaching),
      escrowReached: Boolean(escrowReached),
      paymentMissed: Boolean(paymentMissed),
      loanMilestones: Boolean(loanMilestones),
      webhookUrl,
    });

    return res.json({ success: true, preferences: updated });
  } catch (error: any) {
    logger.error("[NotificationsRouter] Error saving preferences:", { error });
    return res.status(500).json({ error: "Failed to save notification preferences." });
  }
});

/**
 * POST /api/notifications/evaluate
 * Triggers evaluation and dispatch of escrow maturity or milestone alerts based on user settings.
 */
notificationsRouter.post("/evaluate", async (req: Request, res: Response) => {
  const { address, event } = req.body;

  if (!address || !event || !event.type) {
    return res.status(400).json({ error: "Address and event specification are required." });
  }

  try {
    await dispatchMaturityAlerts(address, event);
    return res.json({ success: true, message: `Maturity alert evaluated for ${event.type}` });
  } catch (error: any) {
    logger.error("[NotificationsRouter] Error evaluating maturity alert:", { error });
    return res.status(500).json({ error: "Failed to evaluate maturity alert." });
  }
});
