// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";
import { notificationsRouter } from "../routes/notifications.js";
import {
  getUserInAppNotifications,
  markInAppNotificationRead,
  markAllInAppNotificationsRead,
  createInAppNotification,
} from "../services/db.js";

// Mock the db service
jest.mock("../services/db.js", () => ({
  getNotificationPreference: jest.fn(),
  upsertNotificationPreference: jest.fn(),
  getUserInAppNotifications: jest.fn(),
  markInAppNotificationRead: jest.fn(),
  markAllInAppNotificationsRead: jest.fn(),
  createInAppNotification: jest.fn(),
}));

const TEST_WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const app = express();
app.use(express.json());
app.use("/api/notifications", notificationsRouter);

describe("In-App Notification API Routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /api/notifications", () => {
    it("rejects request missing address parameter", async () => {
      const res = await request(app).get("/api/notifications");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Address or walletAddress");
    });

    it("returns notifications and unreadCount for valid address", async () => {
      const mockNotifs = [
        {
          id: "notif-1",
          walletAddress: TEST_WALLET,
          title: "Deposit Confirmed",
          message: "1000 USDC added to escrow",
          variant: "success",
          read: false,
          createdAt: new Date().toISOString(),
        },
        {
          id: "notif-2",
          walletAddress: TEST_WALLET,
          title: "Welcome",
          message: "Account verified",
          variant: "info",
          read: true,
          createdAt: new Date().toISOString(),
        },
      ];

      (getUserInAppNotifications as jest.Mock).mockResolvedValue(mockNotifs);

      const res = await request(app).get(`/api/notifications?address=${TEST_WALLET}`);

      expect(res.status).toBe(200);
      expect(res.body.notifications).toHaveLength(2);
      expect(res.body.unreadCount).toBe(1);
      expect(getUserInAppNotifications).toHaveBeenCalledWith(TEST_WALLET);
    });
  });

  describe("PATCH /api/notifications/:id/read", () => {
    it("rejects request missing address parameter", async () => {
      const res = await request(app).patch("/api/notifications/notif-1/read").send({});
      expect(res.status).toBe(400);
    });

    it("marks single notification as read", async () => {
      (markInAppNotificationRead as jest.Mock).mockResolvedValue({ count: 1 });

      const res = await request(app)
        .patch("/api/notifications/notif-1/read")
        .send({ address: TEST_WALLET });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(markInAppNotificationRead).toHaveBeenCalledWith("notif-1", TEST_WALLET);
    });
  });

  describe("POST /api/notifications/read-all", () => {
    it("marks all notifications as read for target address", async () => {
      (markAllInAppNotificationsRead as jest.Mock).mockResolvedValue({ count: 3 });

      const res = await request(app)
        .post("/api/notifications/read-all")
        .send({ address: TEST_WALLET });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(markAllInAppNotificationsRead).toHaveBeenCalledWith(TEST_WALLET);
    });
  });

  describe("POST /api/notifications/in-app", () => {
    it("creates a new in-app notification", async () => {
      const createdRecord = {
        id: "notif-new",
        walletAddress: TEST_WALLET,
        title: "Milestone Completed",
        message: "Foundation phase verified",
        variant: "success",
        read: false,
        createdAt: new Date().toISOString(),
      };

      (createInAppNotification as jest.Mock).mockResolvedValue(createdRecord);

      const res = await request(app).post("/api/notifications/in-app").send({
        address: TEST_WALLET,
        title: "Milestone Completed",
        message: "Foundation phase verified",
        variant: "success",
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.notification).toEqual(createdRecord);
      expect(createInAppNotification).toHaveBeenCalledWith({
        walletAddress: TEST_WALLET,
        title: "Milestone Completed",
        message: "Foundation phase verified",
        variant: "success",
        metadata: undefined,
      });
    });
  });
});
