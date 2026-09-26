// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Loan servicing transfer API (issue #693): authorization, notification
 * dispatch, and audit trail integrity. Prisma is replaced by small in-memory
 * tables so the full admin route -> service -> job path runs end to end.
 */

import express from "express";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";

const BORROWER = Keypair.random().publicKey();
const INVESTOR_A = Keypair.random().publicKey();
const INVESTOR_B = Keypair.random().publicKey();
const ADMIN_KEY = "test-admin-key";

type Loan = {
  id: string;
  status: string;
  principal: number;
  interestRateBps: number;
  servicer: string | null;
  servicerContact: string | null;
  deletedAt: Date | null;
  applicant: { stellarAddress: string };
};
const loans: Loan[] = [];
const transfers: any[] = [];
const mockNotifications: any[] = [];
const mockAudit: any[] = [];

jest.mock("../config.js", () => ({
  loadConfig: () => ({ adminApiKey: "test-admin-key" }),
}));
jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../services/audit.js", () => ({
  logAudit: (entry: any) => mockAudit.push(entry),
}));
jest.mock("../services/webhook.js", () => ({ sendWebhook: jest.fn() }));
jest.mock("../jobs/escrowReconciliation.js", () => ({ runEscrowReconciliation: jest.fn() }));
jest.mock("../services/inviteCode.js", () => ({ promoteWaitlistBatch: jest.fn() }));
jest.mock("../services/loanStore.js", () => ({ bulkReviewApplications: jest.fn() }));

jest.mock("../services/db.js", () => {
  const matches = (row: any, where: any) =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (v && typeof v === "object" && "lte" in v) return row[k] <= v.lte;
      return row[k] === v;
    });
  const prisma: any = {
    loanApplication: {
      findFirst: jest.fn(async ({ where, select }: any) => {
        const loan = loans.find((l) => l.id === where.id && l.deletedAt === null);
        if (!loan) return null;
        if (select?.servicingTransfers) {
          return {
            ...loan,
            servicingTransfers: transfers
              .filter((t) => t.loanApplicationId === loan.id)
              .sort((a, b) => a.createdAt - b.createdAt),
          };
        }
        return loan;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const loan = loans.find((l) => l.id === where.id)!;
        Object.assign(loan, data);
        return loan;
      }),
    },
    loanServicingTransfer: {
      findFirst: jest.fn(async ({ where }: any) => transfers.find((t) => matches(t, where)) ?? null),
      findMany: jest.fn(async ({ where }: any) =>
        transfers
          .filter((t) => matches(t, where))
          .sort((a, b) => a.effectiveDate - b.effectiveDate)
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `transfer-${transfers.length + 1}`,
          status: "SCHEDULED",
          notifiedAt: null,
          completedAt: null,
          createdAt: new Date(Date.now() + transfers.length),
          ...data,
        };
        transfers.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = transfers.find((t) => t.id === where.id);
        Object.assign(row, data);
        return { ...row };
      }),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return {
    prisma,
    createInAppNotification: jest.fn(async (n: any) => {
      mockNotifications.push(n);
      return n;
    }),
  };
});

import { adminRouter } from "../routes/admin.js";
import { applyDueServicingTransfers } from "../services/loanServicing.js";

const app = express();
app.use(express.json());
app.use("/api/admin", adminRouter);

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

function transfer(loanId: string, body: Record<string, unknown>, auth = `Bearer ${ADMIN_KEY}`) {
  const req = request(app).post(`/api/admin/loans/${loanId}/servicing-transfer`).send(body);
  return auth ? req.set("Authorization", auth) : req;
}

const validBody = () => ({
  toServicer: "Acme Loan Servicing",
  toServicerContact: "support@acme.example, +1 555 0100",
  effectiveDate: future(15),
  reason: "Servicing rights sold to Acme",
  investorAddresses: [INVESTOR_A, INVESTOR_B, INVESTOR_A],
});

beforeEach(() => {
  loans.length = 0;
  transfers.length = 0;
  mockNotifications.length = 0;
  mockAudit.length = 0;
  loans.push({
    id: "loan-1",
    status: "Repaying",
    principal: 70000,
    interestRateBps: 800,
    servicer: null,
    servicerContact: null,
    deletedAt: null,
    applicant: { stellarAddress: BORROWER },
  });
});

describe("authorization", () => {
  it("rejects requests without admin credentials", async () => {
    const res = await transfer("loan-1", validBody(), "");
    expect(res.status).toBe(401);
    expect(transfers).toHaveLength(0);
  });

  it("rejects a wrong admin key", async () => {
    const res = await transfer("loan-1", validBody(), "Bearer not-the-key");
    expect(res.status).toBe(401);
    expect(transfers).toHaveLength(0);
  });

  it("lets an authorized admin schedule a transfer", async () => {
    const res = await transfer("loan-1", validBody());

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      loanApplicationId: "loan-1",
      fromServicer: null,
      toServicer: "Acme Loan Servicing",
      status: "SCHEDULED",
      initiatedBy: "admin-api-key",
    });
    expect(res.body.notifiedAt).toBeTruthy();
  });
});

describe("validation", () => {
  it.each([
    ["missing servicer", { toServicer: " " }, 400, "missing_field"],
    ["missing reason", { reason: undefined }, 400, "missing_field"],
    ["past effective date", { effectiveDate: new Date(Date.now() - 1000).toISOString() }, 400, "invalid_field"],
    ["bad investor address", { investorAddresses: ["not-an-address"] }, 400, "invalid_field"],
  ])("rejects %s", async (_label, override, status, code) => {
    const res = await transfer("loan-1", { ...validBody(), ...override });
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(code);
    expect(transfers).toHaveLength(0);
  });

  it("returns 404 for an unknown loan and 409 for an inactive one", async () => {
    expect((await transfer("missing", validBody())).status).toBe(404);

    loans[0].status = "Pending";
    const res = await transfer("loan-1", validBody());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("loan_not_active");
  });

  it("rejects a second transfer while one is still scheduled", async () => {
    await transfer("loan-1", validBody());
    const res = await transfer("loan-1", { ...validBody(), toServicer: "Other Servicer" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("transfer_already_scheduled");
  });
});

describe("notification dispatch", () => {
  it("notifies the borrower and each investor once, before the transfer takes effect", async () => {
    await transfer("loan-1", validBody());

    expect(mockNotifications.map((n) => n.walletAddress).sort()).toEqual(
      [BORROWER, INVESTOR_A, INVESTOR_B].sort()
    );
    for (const n of mockNotifications) {
      expect(n.message).toContain("Acme Loan Servicing");
      expect(n.message).toContain("support@acme.example");
      expect(n.message).toContain("terms do not change");
      expect(n.metadata).toMatchObject({ type: "LOAN_SERVICING_TRANSFER", loanId: "loan-1" });
    }
    expect(mockNotifications.find((n) => n.walletAddress === BORROWER).metadata.role).toBe("borrower");

    // Notified at initiation, while the loan is still with the old servicer.
    expect(loans[0].servicer).toBeNull();
  });
});

describe("audit trail", () => {
  it("applies due transfers and keeps every prior servicer queryable", async () => {
    await transfer("loan-1", validBody());
    expect(await applyDueServicingTransfers(new Date())).toBe(0);

    expect(await applyDueServicingTransfers(new Date(future(16)))).toBe(1);
    expect(loans[0]).toMatchObject({
      servicer: "Acme Loan Servicing",
      servicerContact: "support@acme.example, +1 555 0100",
    });

    await transfer("loan-1", {
      ...validBody(),
      toServicer: "Beta Servicing",
      toServicerContact: "help@beta.example",
      effectiveDate: future(30),
      investorAddresses: [],
    });
    await applyDueServicingTransfers(new Date(future(31)));

    const res = await request(app)
      .get("/api/admin/loans/loan-1/servicing-history")
      .set("Authorization", `Bearer ${ADMIN_KEY}`);

    expect(res.status).toBe(200);
    expect(res.body.servicer).toBe("Beta Servicing");
    expect(res.body.transfers).toHaveLength(2);
    expect(res.body.transfers[0]).toMatchObject({
      fromServicer: null,
      toServicer: "Acme Loan Servicing",
      status: "COMPLETED",
    });
    expect(res.body.transfers[1]).toMatchObject({
      fromServicer: "Acme Loan Servicing",
      fromServicerContact: "support@acme.example, +1 555 0100",
      toServicer: "Beta Servicing",
      status: "COMPLETED",
    });
    expect(mockAudit.map((a) => a.action)).toEqual([
      "LOAN_SERVICING_TRANSFER_SCHEDULED",
      "LOAN_SERVICING_TRANSFER_COMPLETED",
      "LOAN_SERVICING_TRANSFER_SCHEDULED",
      "LOAN_SERVICING_TRANSFER_COMPLETED",
    ]);
  });

  it("requires admin credentials to read servicing history", async () => {
    const res = await request(app).get("/api/admin/loans/loan-1/servicing-history");
    expect(res.status).toBe(401);
  });
});
