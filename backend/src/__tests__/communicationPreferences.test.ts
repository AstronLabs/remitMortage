const mockCommunicationPreference = {
  findMany: jest.fn(),
  upsert: jest.fn(),
};

const resolveOrCreateApplicantMock = jest.fn();

jest.mock("../services/db.js", () => ({
  prisma: {
    communicationPreference: mockCommunicationPreference,
  },
  resolveOrCreateApplicant: (...args: unknown[]) => resolveOrCreateApplicantMock(...args),
}));

import {
  getCommunicationPreferences,
  updateCommunicationPreferences,
} from "../services/communicationPreferences";

const APPLICANT = { id: "applicant-1", stellarAddress: "GABC" };

describe("getCommunicationPreferences", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("defaults email and push to enabled and SMS to disabled when no rows exist", async () => {
    resolveOrCreateApplicantMock.mockResolvedValue(APPLICANT);
    mockCommunicationPreference.findMany.mockResolvedValue([]);

    const matrix = await getCommunicationPreferences("GABC");

    for (const category of ["DEPOSITS", "MILESTONES", "GOVERNANCE", "SECURITY"] as const) {
      expect(matrix[category].EMAIL).toEqual({ enabled: true, consentTimestamp: null, consentSource: null });
      expect(matrix[category].PUSH).toEqual({ enabled: true, consentTimestamp: null, consentSource: null });
      expect(matrix[category].SMS).toEqual({ enabled: false, consentTimestamp: null, consentSource: null });
    }
  });

  it("returns the default matrix (no throw) when the applicant can't be resolved", async () => {
    resolveOrCreateApplicantMock.mockResolvedValue(null);

    const matrix = await getCommunicationPreferences("not-a-real-address");

    expect(matrix.DEPOSITS.EMAIL.enabled).toBe(true);
    expect(mockCommunicationPreference.findMany).not.toHaveBeenCalled();
  });

  it("overlays stored rows onto the defaults, leaving other cells untouched", async () => {
    resolveOrCreateApplicantMock.mockResolvedValue(APPLICANT);
    const consentedAt = new Date("2026-01-01T00:00:00.000Z");
    mockCommunicationPreference.findMany.mockResolvedValue([
      {
        category: "DEPOSITS",
        channel: "SMS",
        enabled: true,
        consentTimestamp: consentedAt,
        consentSource: "onboarding",
      },
    ]);

    const matrix = await getCommunicationPreferences("GABC");

    expect(matrix.DEPOSITS.SMS).toEqual({
      enabled: true,
      consentTimestamp: consentedAt.toISOString(),
      consentSource: "onboarding",
    });
    // Untouched cells keep their defaults.
    expect(matrix.DEPOSITS.EMAIL.enabled).toBe(true);
    expect(matrix.MILESTONES.SMS.enabled).toBe(false);
  });
});

describe("updateCommunicationPreferences", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveOrCreateApplicantMock.mockResolvedValue(APPLICANT);
    mockCommunicationPreference.upsert.mockResolvedValue({});
  });

  it("throws when the applicant cannot be resolved or created", async () => {
    resolveOrCreateApplicantMock.mockResolvedValue(null);
    await expect(
      updateCommunicationPreferences("bad-id", [{ category: "DEPOSITS", channel: "SMS", enabled: true }])
    ).rejects.toThrow();
    expect(mockCommunicationPreference.upsert).not.toHaveBeenCalled();
  });

  describe("consent timestamp and source accuracy", () => {
    it("records a fresh consent timestamp and source on a first-time opt-in", async () => {
      mockCommunicationPreference.findMany.mockResolvedValue([]); // no existing rows anywhere

      jest.useFakeTimers().setSystemTime(new Date("2026-02-01T12:00:00.000Z"));

      await updateCommunicationPreferences("GABC", [
        { category: "DEPOSITS", channel: "SMS", enabled: true, source: "settings_page" },
      ]);

      expect(mockCommunicationPreference.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            applicantId: "applicant-1",
            category: "DEPOSITS",
            channel: "SMS",
            enabled: true,
            consentTimestamp: new Date("2026-02-01T12:00:00.000Z"),
            consentSource: "settings_page",
          }),
        })
      );

      jest.useRealTimers();
    });

    it("defaults the consent source when none is supplied", async () => {
      mockCommunicationPreference.findMany.mockResolvedValue([]);

      await updateCommunicationPreferences("GABC", [{ category: "MILESTONES", channel: "PUSH", enabled: true }]);

      const call = mockCommunicationPreference.upsert.mock.calls[0][0];
      expect(call.create.consentSource).toBe("user_settings_update");
    });

    it("does NOT update the consent record when disabling a channel", async () => {
      const consentedAt = new Date("2026-01-01T00:00:00.000Z");
      mockCommunicationPreference.findMany.mockResolvedValue([
        {
          applicantId: "applicant-1",
          category: "DEPOSITS",
          channel: "SMS",
          enabled: true,
          consentTimestamp: consentedAt,
          consentSource: "onboarding",
        },
      ]);

      await updateCommunicationPreferences("GABC", [{ category: "DEPOSITS", channel: "SMS", enabled: false }]);

      const call = mockCommunicationPreference.upsert.mock.calls[0][0];
      expect(call.update).toEqual({ enabled: false });
      expect(call.update).not.toHaveProperty("consentTimestamp");
      expect(call.update).not.toHaveProperty("consentSource");
    });

    it("does NOT refresh the consent record when re-enabling an already-enabled channel", async () => {
      const consentedAt = new Date("2026-01-01T00:00:00.000Z");
      mockCommunicationPreference.findMany.mockResolvedValue([
        {
          applicantId: "applicant-1",
          category: "DEPOSITS",
          channel: "EMAIL",
          enabled: true,
          consentTimestamp: consentedAt,
          consentSource: "onboarding",
        },
      ]);

      jest.useFakeTimers().setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
      await updateCommunicationPreferences("GABC", [{ category: "DEPOSITS", channel: "EMAIL", enabled: true }]);
      jest.useRealTimers();

      const call = mockCommunicationPreference.upsert.mock.calls[0][0];
      expect(call.update).toEqual({ enabled: true });
    });

    it("stamps a new consent record when re-enabling a channel that had been disabled", async () => {
      mockCommunicationPreference.findMany.mockResolvedValue([
        {
          applicantId: "applicant-1",
          category: "DEPOSITS",
          channel: "SMS",
          enabled: false,
          consentTimestamp: new Date("2026-01-01T00:00:00.000Z"),
          consentSource: "onboarding",
        },
      ]);

      jest.useFakeTimers().setSystemTime(new Date("2026-04-01T00:00:00.000Z"));
      await updateCommunicationPreferences("GABC", [
        { category: "DEPOSITS", channel: "SMS", enabled: true, source: "re_opt_in" },
      ]);
      jest.useRealTimers();

      const call = mockCommunicationPreference.upsert.mock.calls[0][0];
      expect(call.update).toEqual({
        enabled: true,
        consentTimestamp: new Date("2026-04-01T00:00:00.000Z"),
        consentSource: "re_opt_in",
      });
    });
  });

  it("applies a batch of updates against the correct unique key per cell", async () => {
    mockCommunicationPreference.findMany.mockResolvedValue([]);

    await updateCommunicationPreferences("GABC", [
      { category: "DEPOSITS", channel: "SMS", enabled: true },
      { category: "MILESTONES", channel: "PUSH", enabled: false },
    ]);

    expect(mockCommunicationPreference.upsert).toHaveBeenCalledTimes(2);
    expect(mockCommunicationPreference.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { applicantId_category_channel: { applicantId: "applicant-1", category: "DEPOSITS", channel: "SMS" } },
      })
    );
    expect(mockCommunicationPreference.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          applicantId_category_channel: { applicantId: "applicant-1", category: "MILESTONES", channel: "PUSH" },
        },
      })
    );
  });
});
