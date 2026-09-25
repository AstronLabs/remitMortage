// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { runApplicationSlaMonitorJob } from "../jobs/applicationSlaMonitor.js";
import { prisma } from "../services/db.js";
import { sendEmail } from "../services/email.js";
import { sendWebhook } from "../services/webhook.js";

// Mock dependencies
jest.mock("../services/db.js", () => ({
  prisma: {
    loanApplication: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock("../services/email.js", () => ({
  sendEmail: jest.fn(),
}));

jest.mock("../services/webhook.js", () => ({
  sendWebhook: jest.fn(),
}));

jest.mock("../config.js", () => ({
  loadConfig: () => ({
    applicationSlaHours: {
      Pending: 48,
      Disbursing: 24,
    },
    opsFallbackAlertEmail: "ops@remitmortgage.com",
    opsSlackWebhookUrl: "https://hooks.slack.com/services/TEST/SLA/ALERT",
  }),
}));

describe("Application SLA Monitor Job", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("triggers email and Slack alerts when an application exceeds the 48h SLA threshold", async () => {
    const fiftyHoursAgo = new Date(Date.now() - 50 * 60 * 60 * 1000);

    const mockStalledApp = {
      id: "app-stalled-1",
      applicantId: "applicant-1",
      principal: 100000,
      status: "Pending",
      assignedReviewerEmail: "reviewer1@remitmortgage.com",
      statusUpdatedAt: fiftyHoursAgo,
      createdAt: fiftyHoursAgo,
      slaAlertSentAt: null,
      applicant: {
        stellarAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      },
    };

    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([mockStalledApp]);
    (sendEmail as jest.Mock).mockResolvedValue(true);
    (sendWebhook as jest.Mock).mockResolvedValue({ success: true, status: 200 });

    const result = await runApplicationSlaMonitorJob();

    expect(result.scannedCount).toBe(1);
    expect(result.breachedCount).toBe(1);

    // Should dispatch to assigned reviewer
    expect(sendEmail).toHaveBeenCalledWith(
      "reviewer1@remitmortgage.com",
      expect.stringContaining("SLA Breach Alert"),
      expect.stringContaining("app-stalled-1")
    );

    // Should dispatch to ops fallback email
    expect(sendEmail).toHaveBeenCalledWith(
      "ops@remitmortgage.com",
      expect.stringContaining("SLA Breach Alert"),
      expect.stringContaining("app-stalled-1")
    );

    // Should send Slack webhook payload
    expect(sendWebhook).toHaveBeenCalledWith(
      "https://hooks.slack.com/services/TEST/SLA/ALERT",
      expect.objectContaining({
        text: expect.stringContaining("app-stalled-1"),
      })
    );

    // Should record alert sent timestamp
    expect(prisma.loanApplication.update).toHaveBeenCalledWith({
      where: { id: "app-stalled-1" },
      data: {
        slaAlertSentAt: expect.any(Date),
      },
    });
  });

  it("does not trigger alert if application has not reached the SLA threshold", async () => {
    const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000);

    const mockFreshApp = {
      id: "app-fresh-1",
      applicantId: "applicant-2",
      principal: 50000,
      status: "Pending",
      assignedReviewerEmail: "reviewer2@remitmortgage.com",
      statusUpdatedAt: tenHoursAgo,
      createdAt: tenHoursAgo,
      slaAlertSentAt: null,
      applicant: null,
    };

    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([mockFreshApp]);

    const result = await runApplicationSlaMonitorJob();

    expect(result.scannedCount).toBe(1);
    expect(result.breachedCount).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendWebhook).not.toHaveBeenCalled();
  });

  it("does not re-trigger alert if alert was already sent for current status cycle", async () => {
    const sixtyHoursAgo = new Date(Date.now() - 60 * 60 * 60 * 1000);
    const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000);

    const mockAlertedApp = {
      id: "app-already-alerted",
      applicantId: "applicant-3",
      principal: 75000,
      status: "Pending",
      assignedReviewerEmail: "reviewer1@remitmortgage.com",
      statusUpdatedAt: sixtyHoursAgo,
      createdAt: sixtyHoursAgo,
      slaAlertSentAt: tenHoursAgo, // Already alerted 10h ago
      applicant: null,
    };

    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([mockAlertedApp]);

    const result = await runApplicationSlaMonitorJob();

    expect(result.scannedCount).toBe(1);
    expect(result.breachedCount).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("excludes non-pending applications (e.g. Approved, Rejected) from SLA scans so alerts stop firing", async () => {
    // When applications are Approved or Rejected, Prisma query filter status in ['Pending', 'Disbursing']
    // returns empty array for non-pending applications.
    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([]);

    const result = await runApplicationSlaMonitorJob();

    expect(result.scannedCount).toBe(0);
    expect(result.breachedCount).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendWebhook).not.toHaveBeenCalled();
    expect(prisma.loanApplication.findMany).toHaveBeenCalledWith({
      where: {
        status: {
          in: ["Pending", "Disbursing"],
        },
      },
      include: {
        applicant: true,
      },
    });
  });
});
