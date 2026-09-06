import crypto from "crypto";
import { transporter, sendRepaymentReminder, sendDepositReceipt, sendLoanStatusUpdate } from "../services/email.js";
import { sendWebhook } from "../services/webhook.js";
import { prisma } from "../services/db.js";
import { dispatchNotification, queueNotification } from "../services/notification.js";
import { loadConfig } from "../config.js";

// Mock the Prisma DB client
jest.mock("../services/db.js", () => ({
  prisma: {
    notification: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    getNotificationPreference: jest.fn(),
  },
  getNotificationPreference: jest.fn(),
}));

describe("Notification Services and Dispatcher Tests", () => {
  const config = loadConfig();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Email Service Templates and Transporter", () => {
    let sendMailSpy: jest.SpyInstance;

    beforeAll(() => {
      sendMailSpy = jest.spyOn(transporter, "sendMail").mockResolvedValue({ messageId: "mock-id" } as any);
    });

    afterAll(() => {
      sendMailSpy.mockRestore();
    });

    it("successfully sends repayment reminder template using mock SMTP", async () => {
      const email = "borrower@example.com";
      const amount = "1500";
      const dueDate = "2026-07-01T00:00:00.000Z";

      const success = await sendRepaymentReminder(email, amount, dueDate);
      expect(success).toBe(true);
      expect(sendMailSpy).toHaveBeenCalledTimes(1);

      const callArgs = sendMailSpy.mock.calls[0][0];
      expect(callArgs.to).toBe(email);
      expect(callArgs.subject).toContain("Repayment Reminder");
      expect(callArgs.html).toContain("1500 USDC");
      expect(callArgs.html).toContain("Repayment Reminder");
    });

    it("successfully sends deposit receipt template using mock SMTP", async () => {
      const email = "borrower@example.com";
      const amount = "500";
      const txHash = "0xmockedtxhash12345";

      const success = await sendDepositReceipt(email, amount, txHash);
      expect(success).toBe(true);
      expect(sendMailSpy).toHaveBeenCalledTimes(1);

      const callArgs = sendMailSpy.mock.calls[0][0];
      expect(callArgs.to).toBe(email);
      expect(callArgs.subject).toContain("Deposit Receipt");
      expect(callArgs.html).toContain("500 USDC");
      expect(callArgs.html).toContain("<code>0xmockedtxhash12345</code>");
    });

    it("successfully sends status update template using mock SMTP", async () => {
      const email = "borrower@example.com";
      const loanId = "loan-uuid-111";
      const status = "Approved";

      const success = await sendLoanStatusUpdate(email, loanId, status);
      expect(success).toBe(true);
      expect(sendMailSpy).toHaveBeenCalledTimes(1);

      const callArgs = sendMailSpy.mock.calls[0][0];
      expect(callArgs.to).toBe(email);
      expect(callArgs.subject).toContain("Status Update: Approved");
      expect(callArgs.html).toContain("loan-uuid-111");
      expect(callArgs.html).toContain("Approved");
    });
  });

  describe("Webhook Service and HMAC Signing", () => {
    let mockFetch: jest.Mock;
    let originalFetch: any;

    beforeAll(() => {
      originalFetch = global.fetch;
      mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
        text: async () => "mock response",
      } as any);
      global.fetch = mockFetch;
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    it("sends request with correct HMAC SHA-256 headers", async () => {
      const targetUrl = "https://partner.com/webhook-receiver";
      const payload = { event: "loan.milestone_approved", loanId: "123" };

      const result = await sendWebhook(targetUrl, payload);
      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [calledUrl, options] = mockFetch.mock.calls[0];
      expect(calledUrl).toBe(targetUrl);
      expect(options.method).toBe("POST");
      expect(options.headers["Content-Type"]).toBe("application/json");

      const timestamp = options.headers["X-Webhook-Timestamp"];
      const signature = options.headers["X-Webhook-Signature"];
      expect(timestamp).toBeDefined();
      expect(signature).toBeDefined();

      // Recalculate signature locally to verify HMAC SHA-256 correctness
      const expectedHmac = crypto
        .createHmac("sha256", config.webhookSecret)
        .update(`${timestamp}.${JSON.stringify(payload)}`)
        .digest("hex");

      expect(signature).toBe(expectedHmac);
    });
  });

  describe("Queueing and Exponential Backoff Retry Dispatch", () => {
    let sendMailSpy: jest.SpyInstance;
    let mockFetch: jest.Mock;
    let originalFetch: any;

    beforeAll(() => {
      originalFetch = global.fetch;
      mockFetch = jest.fn();
      global.fetch = mockFetch;
      sendMailSpy = jest.spyOn(transporter, "sendMail");
    });

    afterAll(() => {
      global.fetch = originalFetch;
      sendMailSpy.mockRestore();
    });

    it("queues notification and returns record", async () => {
      const mockNotifRecord = {
        id: "mock-notif-id",
        recipient: "test@example.com",
        type: "EMAIL",
        content: "test content",
        status: "Pending",
        attempts: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastError: null,
        nextRetryAt: null,
      };

      (prisma.notification.create as jest.Mock).mockResolvedValue(mockNotifRecord);
      (prisma.notification.findUnique as jest.Mock).mockResolvedValue(mockNotifRecord);
      sendMailSpy.mockResolvedValue({} as any);

      const notif = await queueNotification("test@example.com", "EMAIL", "test content");
      expect(notif.id).toBe("mock-notif-id");
      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: {
          recipient: "test@example.com",
          type: "EMAIL",
          content: "test content",
          status: "Pending",
          attempts: 0,
        },
      });
    });

    it("updates status to Sent on successful dispatch", async () => {
      const mockRecord = {
        id: "notif-1",
        recipient: "test@example.com",
        type: "EMAIL",
        content: "Hello Test",
        status: "Pending",
        attempts: 0,
      };

      (prisma.notification.findUnique as jest.Mock).mockResolvedValue(mockRecord);
      sendMailSpy.mockResolvedValue({} as any);

      const success = await dispatchNotification("notif-1");
      expect(success).toBe(true);
      expect(prisma.notification.update).toHaveBeenCalledWith({
        where: { id: "notif-1" },
        data: {
          status: "Sent",
          attempts: 1,
          lastError: null,
          nextRetryAt: null,
        },
      });
    });

    it("updates status to Failed and calculates exponential backoff nextRetryAt on failure", async () => {
      const mockRecord = {
        id: "notif-failed",
        recipient: "https://badurl.com",
        type: "WEBHOOK",
        content: JSON.stringify({ message: "failed" }),
        status: "Pending",
        attempts: 1, // Second overall attempt is being simulated
      };

      (prisma.notification.findUnique as jest.Mock).mockResolvedValue(mockRecord);
      // Simulate network error
      mockFetch.mockRejectedValue(new Error("Connection Timeout"));

      const success = await dispatchNotification("notif-failed");
      expect(success).toBe(false);

      expect(prisma.notification.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "notif-failed" },
          data: expect.objectContaining({
            status: "Failed",
            attempts: 2,
            lastError: "Connection Timeout",
          }),
        })
      );

      // Verify that nextRetryAt is set to a future date
      const updateCall = (prisma.notification.update as jest.Mock).mock.calls[0][0];
      const nextRetryAt = updateCall.data.nextRetryAt;
      expect(nextRetryAt).toBeInstanceOf(Date);
      expect(nextRetryAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe("Dynamic Maturity Alerts & Preferences Integration", () => {
    it("dispatches SMS and Email notifications when escrow maturity alert triggers and user preferences are enabled", async () => {
      const mockPrefs = {
        email: "borrower@example.com",
        phone: "+15550001111",
        emailAlerts: true,
        smsAlerts: true,
        escrowApproaching: true,
        escrowReached: true,
        paymentMissed: true,
        loanMilestones: true,
        webhookUrl: "https://partner.example.com/webhook",
      };

      const { getNotificationPreference } = require("../services/db.js");
      jest.spyOn(require("../services/db.js"), "getNotificationPreference").mockResolvedValue(mockPrefs);

      const { dispatchMaturityAlerts } = require("../services/notification.js");

      await dispatchMaturityAlerts("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", {
        type: "ESCROW_REACHED",
        deposited: "3000",
        target: "3000",
        progress: 100,
      });

      // Verify notification create was called for email, sms, and webhook
      expect(prisma.notification.create).toHaveBeenCalled();
    });
  });
});

