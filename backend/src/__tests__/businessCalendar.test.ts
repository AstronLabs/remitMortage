// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Business-day and bank-holiday calendar for payment cutoffs (issue #980).
 */

jest.mock("../services/db.js", () => ({
  prisma: {
    bankHoliday: { findMany: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
    loanApplication: { findMany: jest.fn(), update: jest.fn() },
    applicant: { findUnique: jest.fn(), findFirst: jest.fn() },
  },
}));
jest.mock("../services/notification.js", () => ({ queueNotification: jest.fn() }));
jest.mock("../i18n/emailI18n.js", () => ({ getEmailTranslator: () => (key: string) => key }));
jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import { prisma } from "../services/db.js";
import {
  addHoliday,
  CalendarValidationError,
  isBusinessDay,
  nextBusinessDay,
  nextBusinessDayFor,
  paymentCutoff,
  removeHoliday,
} from "../services/businessCalendar.js";
import { runRepaymentAudit } from "../jobs/repaymentAudit.js";
import { loanRowFactory } from "../test-utils/factories/index.js";

const db = prisma as unknown as {
  bankHoliday: Record<"findMany" | "upsert" | "deleteMany", jest.Mock>;
  loanApplication: Record<"findMany" | "update", jest.Mock>;
  applicant: Record<"findUnique" | "findFirst", jest.Mock>;
};

const at = (iso: string) => new Date(iso);
const NONE = new Set<string>();
// 2026-12-25 is a Friday and 2026-12-28 the following Monday.
const GB_XMAS = new Set(["2026-12-25", "2026-12-28"]);

/** Serves holidays for one country from an in-memory list. */
function serveHolidays(byCountry: Record<string, string[]>) {
  db.bankHoliday.findMany.mockImplementation(async ({ where }: any) =>
    (byCountry[where.country] ?? []).map((d) => ({ date: new Date(`${d}T00:00:00.000Z`) }))
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  serveHolidays({});
});

describe("nextBusinessDay", () => {
  it("leaves a business day unchanged", () => {
    const wed = at("2026-11-18T09:30:00Z");
    expect(isBusinessDay(wed, NONE)).toBe(true);
    expect(nextBusinessDay(wed, NONE)).toEqual(wed);
  });

  it("moves Saturday and Sunday to Monday, keeping the time of day", () => {
    expect(nextBusinessDay(at("2026-11-21T09:30:00Z"), NONE)).toEqual(at("2026-11-23T09:30:00Z"));
    expect(nextBusinessDay(at("2026-11-22T09:30:00Z"), NONE)).toEqual(at("2026-11-23T09:30:00Z"));
  });

  it("skips a listed holiday", () => {
    const holidays = new Set(["2026-11-26"]);
    expect(isBusinessDay(at("2026-11-26T12:00:00Z"), holidays)).toBe(false);
    expect(nextBusinessDay(at("2026-11-26T12:00:00Z"), holidays)).toEqual(at("2026-11-27T12:00:00Z"));
  });

  it("skips consecutive holidays joined by a weekend", () => {
    expect(nextBusinessDay(at("2026-12-25T10:00:00Z"), GB_XMAS)).toEqual(at("2026-12-29T10:00:00Z"));
  });
});

describe("nextBusinessDayFor", () => {
  it("uses the country's listed holidays", async () => {
    serveHolidays({ GB: [...GB_XMAS] });
    await expect(nextBusinessDayFor(at("2026-12-25T10:00:00Z"), "gb")).resolves.toEqual(at("2026-12-29T10:00:00Z"));
  });

  it("falls back to weekends only for a country with no calendar", async () => {
    serveHolidays({ GB: [...GB_XMAS] });
    await expect(nextBusinessDayFor(at("2026-12-25T10:00:00Z"), "NG")).resolves.toEqual(at("2026-12-25T10:00:00Z"));
    await expect(nextBusinessDayFor(at("2026-12-26T10:00:00Z"), "NG")).resolves.toEqual(at("2026-12-28T10:00:00Z"));
  });

  it("rejects a malformed country code", async () => {
    await expect(nextBusinessDayFor(at("2026-12-25T10:00:00Z"), "Britain")).rejects.toBeInstanceOf(
      CalendarValidationError
    );
  });
});

describe("paymentCutoff", () => {
  it("treats a due date on a listed holiday as the next business day", async () => {
    serveHolidays({ GB: [...GB_XMAS] });
    await expect(paymentCutoff(at("2026-12-25T10:00:00Z"), "GB")).resolves.toEqual(at("2026-12-29T10:00:00Z"));
  });

  it("leaves the due date alone when the borrower's country is unknown", async () => {
    await expect(paymentCutoff(at("2026-12-26T10:00:00Z"), null)).resolves.toEqual(at("2026-12-26T10:00:00Z"));
    expect(db.bankHoliday.findMany).not.toHaveBeenCalled();
  });

  it("applies weekends only if the holiday lookup fails", async () => {
    db.bankHoliday.findMany.mockRejectedValue(new Error("db down"));
    await expect(paymentCutoff(at("2026-12-26T10:00:00Z"), "GB")).resolves.toEqual(at("2026-12-28T10:00:00Z"));
  });
});

describe("admin holiday editing", () => {
  it("adds a holiday keyed by country and UTC date", async () => {
    db.bankHoliday.upsert.mockImplementation(async ({ create }: any) => create);
    const holiday = await addHoliday({ country: "gb", date: "2026-12-28", name: "Boxing Day (substitute)" });

    expect(holiday).toEqual({ country: "GB", date: "2026-12-28", name: "Boxing Day (substitute)" });
    expect(db.bankHoliday.upsert.mock.calls[0][0].where).toEqual({
      country_date: { country: "GB", date: at("2026-12-28T00:00:00.000Z") },
    });
  });

  it("rejects an invalid date", async () => {
    await expect(addHoliday({ country: "GB", date: "2026-02-30" })).rejects.toBeInstanceOf(CalendarValidationError);
    expect(db.bankHoliday.upsert).not.toHaveBeenCalled();
  });

  it("removes a holiday and reports when nothing was listed", async () => {
    db.bankHoliday.deleteMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await expect(removeHoliday("GB", "2026-12-28")).resolves.toBe(true);
    await expect(removeHoliday("GB", "2026-12-28")).resolves.toBe(false);
  });
});

describe("repayment audit cutoff", () => {
  const row = loanRowFactory.build({ id: "loan-xmas", status: "Repaying", dueDate: at("2026-12-25T10:00:00Z") });
  const loan = { ...row, applicant: { ...row.applicant, addressCountry: "GB" } };

  beforeEach(() => {
    serveHolidays({ GB: [...GB_XMAS] });
    db.loanApplication.findMany.mockResolvedValue([loan]);
    db.loanApplication.update.mockResolvedValue({});
    db.applicant.findUnique.mockResolvedValue(null);
  });

  afterEach(() => jest.useRealTimers());

  it("does not start a grace period while the banks are closed", async () => {
    jest.useFakeTimers({ now: at("2026-12-28T12:00:00Z") });
    await runRepaymentAudit();
    expect(db.loanApplication.update).not.toHaveBeenCalled();
  });

  it("starts the grace period once the next business day has passed", async () => {
    jest.useFakeTimers({ now: at("2026-12-29T12:00:00Z") });
    await runRepaymentAudit();
    expect(db.loanApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "loan-xmas" }, data: expect.objectContaining({ gracePeriodEndsAt: expect.any(Date) }) })
    );
  });
});
