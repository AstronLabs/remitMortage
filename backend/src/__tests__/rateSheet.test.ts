// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Interest rate sheet version history (issue #746).
 *
 * Prisma is replaced with in-memory tables so the real rateSheet and
 * loanStore.createApplication code paths run end to end. The key guarantee
 * under test: the rate sheet version stored on an offer is the version that
 * was in effect at the moment the offer was generated, and later publishes
 * never change that answer.
 */

import express from "express";
import request from "supertest";
import { StrKey } from "@stellar/stellar-sdk";

const versions: any[] = [];
const loans: any[] = [];
const applicants: any[] = [];
const auditEntries: any[] = [];
let createFailuresWithP2002 = 0;

function sortBy(rows: any[], orderBy: any) {
  const clauses = (Array.isArray(orderBy) ? orderBy : [orderBy]).filter(Boolean);
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      const [field, dir] = Object.entries(clause)[0] as [string, "asc" | "desc"];
      const av = a[field] instanceof Date ? a[field].getTime() : a[field];
      const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
      if (av !== bv) return (av < bv ? -1 : 1) * (dir === "desc" ? -1 : 1);
    }
    return 0;
  });
}

jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../services/audit.js", () => ({
  logAudit: async (entry: any) => {
    auditEntries.push(entry);
  },
}));
jest.mock("../services/loanHistory.js", () => ({
  recordLoanCreation: jest.fn().mockResolvedValue(undefined),
  recordLoanChange: jest.fn().mockResolvedValue(undefined),
  diffLoanSnapshot: jest.fn(),
}));
jest.mock("../services/assignmentQueue.js", () => ({
  autoAssignApplicationReviewer: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../config.js", () => ({
  loadConfig: () => ({ adminApiKey: "test-admin-key" }),
}));
jest.mock("../middleware/auth.js", () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    if (req.headers.authorization === "Bearer test-admin-key") {
      req.user = { walletAddress: "GADMIN", network: "testnet" };
      Object.defineProperty(req, "ip", { value: "127.0.0.1", configurable: true });
      return next();
    }
    return res.status(401).json({ error: "unauthorized" });
  },
}));
jest.mock("../services/db.js", () => ({
  LOAN_INTEREST_RATE_MIN_BPS: 200,
  LOAN_INTEREST_RATE_MAX_BPS: 1800,
  LOAN_INTEREST_RATE_DEFAULT_BPS: 800,
  prisma: {
    interestRateSheetVersion: {
      findFirst: jest.fn(async ({ where, orderBy }: any = {}) => {
        let rows = [...versions];
        if (where?.effectiveAt?.lte) rows = rows.filter((v) => v.effectiveAt <= where.effectiveAt.lte);
        return sortBy(rows, orderBy)[0] ?? null;
      }),
      findUnique: jest.fn(async ({ where }: any) => versions.find((v) => v.version === where.version) ?? null),
      findMany: jest.fn(async ({ where, orderBy, take }: any) => {
        let rows = [...versions];
        if (where?.version?.lt !== undefined) rows = rows.filter((v) => v.version < where.version.lt);
        return sortBy(rows, orderBy).slice(0, take);
      }),
      create: jest.fn(async ({ data }: any) => {
        if (createFailuresWithP2002 > 0) {
          createFailuresWithP2002--;
          // Simulate a concurrent publisher winning the version number.
          versions.push({
            id: `rsv-${versions.length + 1}`,
            ...data,
            version: data.version,
            rates: { baseRateBps: 999 },
            changedValues: [],
            changedBy: "racer",
            createdAt: new Date(),
          });
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        if (versions.some((v) => v.version === data.version)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row = { id: `rsv-${versions.length + 1}`, createdAt: new Date(), ...data };
        versions.push(row);
        return row;
      }),
    },
    applicant: {
      upsert: jest.fn(async ({ where }: any) => {
        const found = applicants.find((a) => a.stellarAddress === where.stellarAddress);
        if (found) return found;
        const created = { id: `app-${applicants.length + 1}`, stellarAddress: where.stellarAddress, creditScore: null };
        applicants.push(created);
        return created;
      }),
    },
    loanApplication: {
      create: jest.fn(async ({ data }: any) => {
        const applicant = applicants.find((a) => a.id === data.applicantId);
        const row = { createdAt: new Date(), interestRateBps: 800, rateSheetVersionId: null, ...data, applicant };
        loans.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const loan = loans.find((l) => l.id === where.id);
        if (!loan) return null;
        return { ...loan, rateSheetVersion: versions.find((v) => v.id === loan.rateSheetVersionId) ?? null };
      }),
    },
  },
}));

import {
  validateRates,
  diffRates,
  priceOffer,
  publishRateSheet,
  resolveRateSheetAt,
  listRateSheetVersions,
  diffRateSheetVersions,
  getRateSheetForLoan,
  RateSheetError,
} from "../services/rateSheet.js";
import { createApplication } from "../services/loanStore.js";
import { rateSheetAdminRouter } from "../routes/rateSheet.js";

const ADDRESS = StrKey.encodeEd25519PublicKey(Buffer.alloc(32));
const T0 = new Date("2026-09-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function seedBaseline() {
  versions.push({
    id: "rsv-1",
    version: 1,
    effectiveAt: T0,
    rates: { baseRateBps: 800 },
    changedValues: [{ path: "baseRateBps", before: null, after: 800 }],
    changedBy: "system:migration",
    changeReason: "baseline",
    createdAt: T0,
  });
}

function setClock(date: Date) {
  jest.setSystemTime(date);
}

beforeEach(() => {
  versions.length = 0;
  loans.length = 0;
  applicants.length = 0;
  auditEntries.length = 0;
  createFailuresWithP2002 = 0;
  jest.useFakeTimers({ now: new Date(T0.getTime() + 1000) });
  seedBaseline();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("validateRates", () => {
  it("accepts a base-only sheet", () => {
    expect(validateRates({ baseRateBps: 750 })).toEqual({ baseRateBps: 750 });
  });

  it("returns tiers in canonical (ascending) order", () => {
    const rates = validateRates({
      baseRateBps: 900,
      creditScoreTiers: [
        { minCreditScore: 700, rateBps: 600 },
        { minCreditScore: 500, rateBps: 800 },
      ],
    });
    expect(rates.creditScoreTiers!.map((t) => t.minCreditScore)).toEqual([500, 700]);
  });

  it.each([
    [{ baseRateBps: 199 }],
    [{ baseRateBps: 1801 }],
    [{ baseRateBps: 8.5 }],
    [{ baseRateBps: "800" }],
    [{}],
    [null],
    [[]],
    [{ baseRateBps: 800, creditScoreTiers: "x" }],
    [{ baseRateBps: 800, creditScoreTiers: [{ minCreditScore: -1, rateBps: 500 }] }],
    [{ baseRateBps: 800, creditScoreTiers: [{ minCreditScore: 700, rateBps: 5000 }] }],
    [
      {
        baseRateBps: 800,
        creditScoreTiers: [
          { minCreditScore: 700, rateBps: 500 },
          { minCreditScore: 700, rateBps: 600 },
        ],
      },
    ],
  ])("rejects invalid rates %j", (input) => {
    expect(() => validateRates(input)).toThrow(RateSheetError);
  });
});

describe("diffRates / priceOffer", () => {
  it("records the base rate as changed from nothing on a first version", () => {
    expect(diffRates(null, { baseRateBps: 800 })).toEqual([{ path: "baseRateBps", before: null, after: 800 }]);
  });

  it("reports base changes and tier additions, removals and edits", () => {
    const from = {
      baseRateBps: 800,
      creditScoreTiers: [
        { minCreditScore: 600, rateBps: 700 },
        { minCreditScore: 700, rateBps: 600 },
      ],
    };
    const to = {
      baseRateBps: 850,
      creditScoreTiers: [
        { minCreditScore: 700, rateBps: 550 },
        { minCreditScore: 800, rateBps: 400 },
      ],
    };
    expect(diffRates(from, to)).toEqual([
      { path: "baseRateBps", before: 800, after: 850 },
      { path: "creditScoreTiers[>=600]", before: 700, after: null },
      { path: "creditScoreTiers[>=700]", before: 600, after: 550 },
      { path: "creditScoreTiers[>=800]", before: null, after: 400 },
    ]);
  });

  it("is empty for identical sheets", () => {
    const rates = { baseRateBps: 800, creditScoreTiers: [{ minCreditScore: 700, rateBps: 600 }] };
    expect(diffRates(rates, { ...rates })).toEqual([]);
  });

  it("prices with the highest tier at or below the score, else the base rate", () => {
    const rates = {
      baseRateBps: 900,
      creditScoreTiers: [
        { minCreditScore: 600, rateBps: 800 },
        { minCreditScore: 700, rateBps: 600 },
      ],
    };
    expect(priceOffer(rates, 750)).toBe(600);
    expect(priceOffer(rates, 700)).toBe(600);
    expect(priceOffer(rates, 650)).toBe(800);
    expect(priceOffer(rates, 599)).toBe(900);
    expect(priceOffer(rates, null)).toBe(900);
  });
});

describe("publishRateSheet", () => {
  it("appends a new version with author, effective time and diff, leaving prior versions untouched", async () => {
    const v1Before = JSON.stringify(versions[0]);
    setClock(new Date(T0.getTime() + DAY));

    const v2 = await publishRateSheet({
      rates: { baseRateBps: 700 },
      changedBy: "GADMIN",
      changeReason: "Q4 pricing",
      ipAddress: "10.0.0.1",
    });

    expect(v2.version).toBe(2);
    expect(v2.changedBy).toBe("GADMIN");
    expect(v2.changeReason).toBe("Q4 pricing");
    expect(v2.effectiveAt).toEqual(new Date(T0.getTime() + DAY));
    expect(v2.changedValues).toEqual([{ path: "baseRateBps", before: 800, after: 700 }]);
    expect(versions).toHaveLength(2);
    // v1 is byte-for-byte what it was.
    expect(JSON.stringify(versions[0])).toBe(v1Before);
    expect(auditEntries).toEqual([
      expect.objectContaining({ action: "RATE_SHEET_PUBLISHED", actorAddress: "GADMIN", ipAddress: "10.0.0.1" }),
    ]);
  });

  it("rejects a publish that changes nothing", async () => {
    await expect(publishRateSheet({ rates: { baseRateBps: 800 }, changedBy: "GADMIN" })).rejects.toMatchObject({
      code: "no_changes",
      httpStatus: 409,
    });
    expect(versions).toHaveLength(1);
  });

  it("rejects a backdated effective time", async () => {
    await expect(
      publishRateSheet({ rates: { baseRateBps: 700 }, changedBy: "GADMIN", effectiveAt: new Date(T0.getTime() - DAY).toISOString() })
    ).rejects.toMatchObject({ code: "invalid_field" });
    expect(versions).toHaveLength(1);
  });

  it("rejects an unparseable effective time and a blank reason", async () => {
    await expect(
      publishRateSheet({ rates: { baseRateBps: 700 }, changedBy: "GADMIN", effectiveAt: "not-a-date" })
    ).rejects.toMatchObject({ code: "invalid_field" });
    await expect(
      publishRateSheet({ rates: { baseRateBps: 700 }, changedBy: "GADMIN", changeReason: "  " })
    ).rejects.toMatchObject({ code: "invalid_field" });
  });

  it("recomputes the diff against the new latest version when a concurrent publish wins", async () => {
    createFailuresWithP2002 = 1; // a racer inserts version 2 (base 999) first

    const created = await publishRateSheet({ rates: { baseRateBps: 700 }, changedBy: "GADMIN" });

    expect(created.version).toBe(3);
    expect(created.changedValues).toEqual([{ path: "baseRateBps", before: 999, after: 700 }]);
  });
});

describe("offer traceability to the rate sheet in effect at generation time", () => {
  it("stores the version that was in effect when each offer was generated", async () => {
    // v2 takes effect at T0+1d.
    setClock(new Date(T0.getTime() + DAY));
    const v2 = await publishRateSheet({
      rates: { baseRateBps: 700, creditScoreTiers: [{ minCreditScore: 700, rateBps: 500 }] },
      changedBy: "GADMIN",
    });
    setClock(new Date(T0.getTime() + DAY + 1000));
    applicants.push({ id: "app-hi", stellarAddress: ADDRESS, creditScore: 720 });
    const offerA = await createApplication(ADDRESS, "1000");

    // v3 takes effect at T0+2d; offer B is generated afterwards.
    setClock(new Date(T0.getTime() + 2 * DAY));
    const v3 = await publishRateSheet({ rates: { baseRateBps: 900 }, changedBy: "GADMIN2" });
    setClock(new Date(T0.getTime() + 2 * DAY + 1000));
    const offerB = await createApplication(ADDRESS, "2000");

    expect(offerA.rateSheetVersionId).toBe(v2.id);
    expect(offerA.interestRateBps).toBe(500); // 720 score hits the >=700 tier on v2
    expect(offerB.rateSheetVersionId).toBe(v3.id);
    expect(offerB.interestRateBps).toBe(900);

    // What was stored matches what resolution says was in effect at each offer's creation instant.
    for (const offer of [offerA, offerB]) {
      const inEffect = await resolveRateSheetAt(new Date(offer.createdAt));
      expect(offer.rateSheetVersionId).toBe(inEffect!.id);
    }
  });

  it("keeps an old offer pointing at its original version after later publishes", async () => {
    setClock(new Date(T0.getTime() + DAY));
    const v2 = await publishRateSheet({ rates: { baseRateBps: 700 }, changedBy: "GADMIN" });
    setClock(new Date(T0.getTime() + DAY + 1000));
    const offer = await createApplication(ADDRESS, "1000");

    setClock(new Date(T0.getTime() + 3 * DAY));
    await publishRateSheet({ rates: { baseRateBps: 1200 }, changedBy: "GADMIN" });
    await publishRateSheet({ rates: { baseRateBps: 1500 }, changedBy: "GADMIN" });

    const trace = await getRateSheetForLoan(offer.id);
    expect(trace!.rateSheetVersionId).toBe(v2.id);
    expect(trace!.rateSheetVersion.version).toBe(2);
    expect(trace!.rateSheetVersion.rates).toEqual({ baseRateBps: 700 });
    expect(trace!.interestRateBps).toBe(priceOffer(trace!.rateSheetVersion.rates, null));
  });

  it("does not price from a version scheduled for the future until it takes effect", async () => {
    setClock(new Date(T0.getTime() + DAY));
    const future = await publishRateSheet({
      rates: { baseRateBps: 600 },
      changedBy: "GADMIN",
      effectiveAt: new Date(T0.getTime() + 5 * DAY).toISOString(),
    });

    const now = await createApplication(ADDRESS, "1000");
    expect(now.rateSheetVersionId).toBe("rsv-1");
    expect(now.interestRateBps).toBe(800);

    setClock(new Date(T0.getTime() + 5 * DAY + 1000));
    const later = await createApplication(ADDRESS, "1000");
    expect(later.rateSheetVersionId).toBe(future.id);
    expect(later.interestRateBps).toBe(600);
  });

  it("prices applicants without a credit score at the base rate", async () => {
    setClock(new Date(T0.getTime() + DAY));
    await publishRateSheet({
      rates: { baseRateBps: 900, creditScoreTiers: [{ minCreditScore: 600, rateBps: 700 }] },
      changedBy: "GADMIN",
    });
    const offer = await createApplication(ADDRESS, "1000");
    expect(offer.interestRateBps).toBe(900);
  });

  it("returns a null version for loans created before rate sheets were versioned", async () => {
    loans.push({ id: "legacy", createdAt: new Date("2025-01-01"), interestRateBps: 800, rateSheetVersionId: null });
    const trace = await getRateSheetForLoan("legacy");
    expect(trace).toMatchObject({ loanId: "legacy", rateSheetVersionId: null, rateSheetVersion: null });
    expect(await getRateSheetForLoan("missing")).toBeNull();
  });
});

describe("history and diff", () => {
  it("lists every version newest first and diffs any two", async () => {
    setClock(new Date(T0.getTime() + DAY));
    await publishRateSheet({ rates: { baseRateBps: 700 }, changedBy: "A" });
    await publishRateSheet({
      rates: { baseRateBps: 700, creditScoreTiers: [{ minCreditScore: 700, rateBps: 500 }] },
      changedBy: "B",
    });

    const history = await listRateSheetVersions();
    expect(history.map((v: any) => v.version)).toEqual([3, 2, 1]);
    expect(history.map((v: any) => v.changedBy)).toEqual(["B", "A", "system:migration"]);

    const diff = await diffRateSheetVersions(1, 3);
    expect(diff.changes).toEqual([
      { path: "baseRateBps", before: 800, after: 700 },
      { path: "creditScoreTiers[>=700]", before: null, after: 500 },
    ]);
    await expect(diffRateSheetVersions(1, 99)).rejects.toMatchObject({ code: "not_found", httpStatus: 404 });
  });
});

describe("admin routes", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", rateSheetAdminRouter);
  const AUTH = { Authorization: "Bearer test-admin-key" };

  it("requires admin auth on every route", async () => {
    for (const [method, path] of [
      ["get", "/api/admin/rate-sheets"],
      ["get", "/api/admin/rate-sheets/current"],
      ["get", "/api/admin/rate-sheets/diff?to=1"],
      ["get", "/api/admin/rate-sheets/1"],
      ["post", "/api/admin/rate-sheets"],
      ["get", "/api/admin/loans/x/rate-sheet"],
    ] as const) {
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(401);
    }
  });

  it("publishes, lists, fetches, and diffs versions", async () => {
    setClock(new Date(T0.getTime() + DAY));
    const created = await request(app)
      .post("/api/admin/rate-sheets")
      .set(AUTH)
      .send({ rates: { baseRateBps: 650 }, changeReason: "promo" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ version: 2, changedBy: "GADMIN", changeReason: "promo" });

    const list = await request(app).get("/api/admin/rate-sheets").set(AUTH);
    expect(list.body.versions.map((v: any) => v.version)).toEqual([2, 1]);

    const current = await request(app).get("/api/admin/rate-sheets/current").set(AUTH);
    expect(current.body.version).toBe(2);

    const one = await request(app).get("/api/admin/rate-sheets/1").set(AUTH);
    expect(one.body.rates).toEqual({ baseRateBps: 800 });

    // "from" defaults to the previous version.
    const diff = await request(app).get("/api/admin/rate-sheets/diff?to=2").set(AUTH);
    expect(diff.status).toBe(200);
    expect(diff.body.changes).toEqual([{ path: "baseRateBps", before: 800, after: 650 }]);
  });

  it("maps validation and lookup failures to 4xx", async () => {
    const bad = await request(app).post("/api/admin/rate-sheets").set(AUTH).send({ rates: { baseRateBps: 5 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_rate");

    const same = await request(app).post("/api/admin/rate-sheets").set(AUTH).send({ rates: { baseRateBps: 800 } });
    expect(same.status).toBe(409);

    expect((await request(app).get("/api/admin/rate-sheets/abc").set(AUTH)).status).toBe(400);
    expect((await request(app).get("/api/admin/rate-sheets/42").set(AUTH)).status).toBe(404);
    expect((await request(app).get("/api/admin/rate-sheets/diff").set(AUTH)).status).toBe(400);
    expect((await request(app).get("/api/admin/rate-sheets/diff?to=1").set(AUTH)).status).toBe(400); // from would be 0
    expect((await request(app).get("/api/admin/loans/nope/rate-sheet").set(AUTH)).status).toBe(404);
  });

  it("traces a loan to its rate sheet version", async () => {
    const offer = await createApplication(ADDRESS, "1000");
    const res = await request(app).get(`/api/admin/loans/${offer.id}/rate-sheet`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ loanId: offer.id, rateSheetVersionId: "rsv-1", interestRateBps: 800 });
    expect(res.body.rateSheetVersion.version).toBe(1);
  });
});
