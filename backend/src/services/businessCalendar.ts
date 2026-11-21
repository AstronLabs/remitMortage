// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Business-day and bank-holiday calendar for payment cutoffs (issue #980).
 *
 * Saturdays and Sundays are never business days. On top of that, admins keep
 * a per-country list of bank holidays in the `BankHoliday` table, so a new
 * holiday takes effect without a deploy. A country with no listed holidays
 * falls back to weekends only.
 */

import { prisma } from "./db.js";
import logger from "../utils/logger.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Upper bound on how far ahead a run of non-business days is searched. */
const MAX_LOOKAHEAD_DAYS = 31;

export class CalendarValidationError extends Error {
  constructor(
    readonly field: "country" | "date",
    message: string
  ) {
    super(message);
    this.name = "CalendarValidationError";
  }
}

/** UTC calendar date of `date` as YYYY-MM-DD. */
export function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function normalizeCountry(country: unknown): string | null {
  if (typeof country !== "string") return null;
  const code = country.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

export function isBusinessDay(date: Date, holidays: ReadonlySet<string>): boolean {
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !holidays.has(toDateKey(date));
}

/**
 * The first business day on or after `date`, keeping its time of day. A date
 * that is already a business day is returned unchanged.
 */
export function nextBusinessDay(date: Date, holidays: ReadonlySet<string>): Date {
  const result = new Date(date.getTime());
  for (let i = 0; i < MAX_LOOKAHEAD_DAYS && !isBusinessDay(result, holidays); i++) {
    result.setUTCDate(result.getUTCDate() + 1);
  }
  return result;
}

/** Holiday date keys for `country` in the window the lookahead can reach. */
export async function loadHolidaySet(country: string, from: Date): Promise<Set<string>> {
  const start = new Date(`${toDateKey(from)}T00:00:00.000Z`);
  const rows: { date: Date }[] = await prisma.bankHoliday.findMany({
    where: { country, date: { gte: start, lt: new Date(start.getTime() + MAX_LOOKAHEAD_DAYS * DAY_MS) } },
    select: { date: true },
  });
  return new Set(rows.map((row) => toDateKey(new Date(row.date))));
}

/** Next business day on or after `date` for `country`. */
export async function nextBusinessDayFor(date: Date, country: string): Promise<Date> {
  const code = normalizeCountry(country);
  if (!code) throw new CalendarValidationError("country", "country must be an ISO 3166-1 alpha-2 code");
  return nextBusinessDay(date, await loadHolidaySet(code, date));
}

/**
 * Cutoff for a payment due at `dueDate` from a borrower in `country`: the due
 * date moved to the next business day. When the borrower's country is not
 * known the due date is left as is, since there is no calendar to apply. A
 * failed holiday lookup falls back to weekends only rather than blocking.
 */
export async function paymentCutoff(dueDate: Date, country: string | null | undefined): Promise<Date> {
  const code = normalizeCountry(country);
  if (!code) return dueDate;
  try {
    return nextBusinessDay(dueDate, await loadHolidaySet(code, dueDate));
  } catch (error) {
    logger.warn("Bank holiday lookup failed; applying weekends only", { country: code, error });
    return nextBusinessDay(dueDate, new Set());
  }
}

/** Mailing country of a borrower, or null when unknown or unreadable. */
export async function countryForBorrower(stellarAddress: string): Promise<string | null> {
  try {
    const applicant = await prisma.applicant.findFirst({
      where: { stellarAddress, deletedAt: null },
      select: { addressCountry: true },
    });
    return normalizeCountry(applicant?.addressCountry);
  } catch {
    return null;
  }
}

function parseDateKey(value: unknown): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new CalendarValidationError("date", "date must be YYYY-MM-DD");
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || toDateKey(date) !== value) {
    throw new CalendarValidationError("date", "date is not a valid calendar date");
  }
  return date;
}

function requireCountry(country: unknown): string {
  const code = normalizeCountry(country);
  if (!code) throw new CalendarValidationError("country", "country must be an ISO 3166-1 alpha-2 code");
  return code;
}

export interface HolidayView {
  country: string;
  date: string;
  name: string | null;
}

function toView(row: { country: string; date: Date; name: string | null }): HolidayView {
  return { country: row.country, date: toDateKey(new Date(row.date)), name: row.name ?? null };
}

export async function listHolidays(country?: unknown): Promise<HolidayView[]> {
  const where = country === undefined ? {} : { country: requireCountry(country) };
  const rows = await prisma.bankHoliday.findMany({
    where,
    orderBy: [{ country: "asc" }, { date: "asc" }],
  });
  return rows.map(toView);
}

export async function addHoliday(input: {
  country: unknown;
  date: unknown;
  name?: unknown;
  createdBy?: string | null;
}): Promise<HolidayView> {
  const country = requireCountry(input.country);
  const date = parseDateKey(input.date);
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 120) : null;
  const row = await prisma.bankHoliday.upsert({
    where: { country_date: { country, date } },
    create: { country, date, name, createdBy: input.createdBy ?? null },
    update: { name },
  });
  return toView(row);
}

/** Removes a holiday; resolves false when it was not listed. */
export async function removeHoliday(country: unknown, date: unknown): Promise<boolean> {
  const result = await prisma.bankHoliday.deleteMany({
    where: { country: requireCountry(country), date: parseDateKey(date) },
  });
  return result.count > 0;
}
