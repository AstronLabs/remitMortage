import jwt from "jsonwebtoken";

const mockImpersonationSession = {
  create: jest.fn(),
  findUnique: jest.fn(),
  update: jest.fn(),
  findFirst: jest.fn(),
};

jest.mock("../services/db.js", () => ({
  prisma: {
    impersonationSession: mockImpersonationSession,
  },
}));

jest.mock("../config.js", () => ({
  loadConfig: () => ({ stellarNetwork: "testnet" }),
}));

const logAuditMock = jest.fn();
jest.mock("../services/audit.js", () => ({
  logAudit: (...args: unknown[]) => logAuditMock(...args),
}));

import {
  IMPERSONATION_SESSION_TTL_MS,
  endImpersonation,
  getImpersonationStatus,
  isImpersonationSessionActive,
  startImpersonation,
} from "../services/impersonation";

const ADMIN = "GADMIN1111111111111111111111111111111111111111111111";
const TARGET = "GTARGET2222222222222222222222222222222222222222222222";
const JWT_SECRET = process.env.JWT_SECRET || "default_jwt_secret";

describe("startImpersonation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("creates a session record and returns a scoped, read-only JWT", async () => {
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    const expiresAt = new Date(startedAt.getTime() + IMPERSONATION_SESSION_TTL_MS);
    mockImpersonationSession.create.mockResolvedValue({
      id: "session-1",
      adminAddress: ADMIN,
      targetAddress: TARGET,
      startedAt,
      expiresAt,
    });

    const result = await startImpersonation({
      adminAddress: ADMIN,
      targetAddress: TARGET,
      ipAddress: "127.0.0.1",
      reason: "support ticket #42",
    });

    expect(mockImpersonationSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          adminAddress: ADMIN,
          targetAddress: TARGET,
          ipAddress: "127.0.0.1",
          reason: "support ticket #42",
        }),
      })
    );

    expect(result.sessionId).toBe("session-1");

    // The issued token identifies the impersonated user, not the admin, and
    // is marked read-only — this is what authMiddleware enforces against.
    const decoded = jwt.verify(result.token, JWT_SECRET) as any;
    expect(decoded.walletAddress).toBe(TARGET);
    expect(decoded.impersonation).toEqual({
      sessionId: "session-1",
      adminAddress: ADMIN,
      readOnly: true,
    });
  });

  it("rejects an admin attempting to impersonate their own wallet", async () => {
    await expect(
      startImpersonation({ adminAddress: ADMIN, targetAddress: ADMIN })
    ).rejects.toThrow(/cannot impersonate their own wallet/i);

    expect(mockImpersonationSession.create).not.toHaveBeenCalled();
  });

  it("logs the session start to the audit trail with actor, target, and timing", async () => {
    mockImpersonationSession.create.mockResolvedValue({
      id: "session-2",
      adminAddress: ADMIN,
      targetAddress: TARGET,
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + IMPERSONATION_SESSION_TTL_MS),
    });

    await startImpersonation({ adminAddress: ADMIN, targetAddress: TARGET, ipAddress: "10.0.0.1" });

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin_impersonation_started",
        actorAddress: ADMIN,
        ipAddress: "10.0.0.1",
        metadata: expect.objectContaining({
          sessionId: "session-2",
          targetAddress: TARGET,
        }),
      })
    );
  });
});

describe("endImpersonation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("marks the session ended and logs start/end times with a computed duration", async () => {
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    mockImpersonationSession.findUnique.mockResolvedValue({
      id: "session-3",
      adminAddress: ADMIN,
      targetAddress: TARGET,
      startedAt,
      endedAt: null,
    });
    mockImpersonationSession.update.mockResolvedValue({});

    jest.useFakeTimers().setSystemTime(new Date("2026-01-01T00:10:00.000Z"));

    await endImpersonation({ sessionId: "session-3", endedBy: ADMIN });

    expect(mockImpersonationSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "session-3" },
        data: expect.objectContaining({ endedBy: ADMIN }),
      })
    );

    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin_impersonation_ended",
        actorAddress: ADMIN,
        metadata: expect.objectContaining({
          sessionId: "session-3",
          targetAddress: TARGET,
          endedBy: ADMIN,
          startedAt: startedAt.toISOString(),
          durationMs: 10 * 60 * 1000,
        }),
      })
    );

    jest.useRealTimers();
  });

  it("is a no-op for a session that was already ended (no duplicate audit entry)", async () => {
    mockImpersonationSession.findUnique.mockResolvedValue({
      id: "session-4",
      adminAddress: ADMIN,
      targetAddress: TARGET,
      startedAt: new Date(),
      endedAt: new Date(), // already ended
    });

    await endImpersonation({ sessionId: "session-4", endedBy: ADMIN });

    expect(mockImpersonationSession.update).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("is a no-op for an unknown session id", async () => {
    mockImpersonationSession.findUnique.mockResolvedValue(null);

    await endImpersonation({ sessionId: "does-not-exist", endedBy: ADMIN });

    expect(mockImpersonationSession.update).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});

describe("isImpersonationSessionActive", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns false for a nonexistent session", async () => {
    mockImpersonationSession.findUnique.mockResolvedValue(null);
    expect(await isImpersonationSessionActive("missing")).toBe(false);
  });

  it("returns false for an explicitly ended session", async () => {
    mockImpersonationSession.findUnique.mockResolvedValue({
      endedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await isImpersonationSessionActive("ended")).toBe(false);
  });

  it("returns false for an expired session even if never explicitly ended", async () => {
    mockImpersonationSession.findUnique.mockResolvedValue({
      endedAt: null,
      expiresAt: new Date(Date.now() - 1),
    });
    expect(await isImpersonationSessionActive("expired")).toBe(false);
  });

  it("returns true for a live, unexpired, unended session", async () => {
    mockImpersonationSession.findUnique.mockResolvedValue({
      endedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await isImpersonationSessionActive("live")).toBe(true);
  });

  it("fails closed if the database lookup throws", async () => {
    mockImpersonationSession.findUnique.mockRejectedValue(new Error("connection lost"));
    expect(await isImpersonationSessionActive("boom")).toBe(false);
  });
});

describe("getImpersonationStatus", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reports inactive for a null session id", async () => {
    const status = await getImpersonationStatus(null);
    expect(status).toEqual({
      active: false,
      sessionId: null,
      adminAddress: null,
      targetAddress: null,
      startedAt: null,
      expiresAt: null,
    });
  });

  it("reports full session details while active", async () => {
    const startedAt = new Date();
    const expiresAt = new Date(Date.now() + 60_000);
    mockImpersonationSession.findUnique.mockResolvedValue({
      id: "session-5",
      adminAddress: ADMIN,
      targetAddress: TARGET,
      startedAt,
      expiresAt,
      endedAt: null,
    });

    const status = await getImpersonationStatus("session-5");
    expect(status).toEqual({
      active: true,
      sessionId: "session-5",
      adminAddress: ADMIN,
      targetAddress: TARGET,
      startedAt: startedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
  });
});
