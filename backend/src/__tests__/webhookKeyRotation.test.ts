// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { runWebhookKeyRotationSweep } from "../jobs/webhookKeyRotation.js";
import { rotateDueSecrets, pruneExpiredPreviousSecrets } from "../services/webhook.js";
import { queueNotification } from "../services/notification.js";
import { prisma } from "../services/db.js";

jest.mock("../services/webhook.js", () => ({
  rotateDueSecrets: jest.fn(),
  pruneExpiredPreviousSecrets: jest.fn(),
  ROTATION_INTERVAL_DAYS: 90,
  ROTATION_GRACE_PERIOD_DAYS: 7,
}));

jest.mock("../services/notification.js", () => ({
  queueNotification: jest.fn(),
}));

jest.mock("../services/db.js", () => ({
  prisma: {
    webhookSubscription: {
      findMany: jest.fn(),
    },
  },
}));

jest.mock("../config.js", () => ({
  loadConfig: jest.fn(),
}));

import { loadConfig } from "../config.js";

describe("runWebhookKeyRotationSweep", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("prunes expired previous secrets even when nothing was due for rotation", async () => {
    (rotateDueSecrets as jest.Mock).mockResolvedValue({ rotatedIds: [], secrets: {} });
    (pruneExpiredPreviousSecrets as jest.Mock).mockResolvedValue(2);
    (loadConfig as jest.Mock).mockReturnValue({ webhookRotationNotifyEmail: "" });

    const result = await runWebhookKeyRotationSweep();

    expect(result).toEqual({ rotated: 0, pruned: 2 });
    expect(queueNotification).not.toHaveBeenCalled();
  });

  it("notifies the configured operator email with the new secret for each rotated subscription", async () => {
    (rotateDueSecrets as jest.Mock).mockResolvedValue({
      rotatedIds: ["sub-1"],
      secrets: { "sub-1": "brand-new-secret" },
    });
    (pruneExpiredPreviousSecrets as jest.Mock).mockResolvedValue(0);
    (loadConfig as jest.Mock).mockReturnValue({ webhookRotationNotifyEmail: "ops@example.com" });
    (prisma.webhookSubscription.findMany as jest.Mock).mockResolvedValue([
      { id: "sub-1", label: "Acme Underwriter" },
    ]);

    const result = await runWebhookKeyRotationSweep();

    expect(result).toEqual({ rotated: 1, pruned: 0 });
    expect(queueNotification).toHaveBeenCalledWith(
      "ops@example.com",
      "EMAIL",
      expect.stringContaining("brand-new-secret")
    );
  });

  it("skips notification when no operator email is configured", async () => {
    (rotateDueSecrets as jest.Mock).mockResolvedValue({
      rotatedIds: ["sub-1"],
      secrets: { "sub-1": "brand-new-secret" },
    });
    (pruneExpiredPreviousSecrets as jest.Mock).mockResolvedValue(0);
    (loadConfig as jest.Mock).mockReturnValue({ webhookRotationNotifyEmail: "" });

    const result = await runWebhookKeyRotationSweep();

    expect(result).toEqual({ rotated: 1, pruned: 0 });
    expect(queueNotification).not.toHaveBeenCalled();
  });
});
