// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Contract-event replay (issue #981).
 *
 * Feeds events captured from the real contracts (see
 * docs/CONTRACT_EVENT_FIXTURES.md) through the event indexer and checks the
 * database state a full loan lifecycle leaves behind. The real `db.ts`
 * recorders run against an in-memory Prisma client, so balance arithmetic and
 * duplicate-event handling are the production code paths.
 *
 * fixture-ok: the in-memory Prisma tables below are storage, not entity fixtures.
 */

jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client");
  type Row = Record<string, any>;
  const tables: Record<string, Row[]> = {
    borrower: [],
    escrowDeposit: [],
    escrowWithdrawal: [],
    loanDisbursement: [],
    loanRepayment: [],
    eventIndexerState: [],
    loanApplication: [],
  };
  let seq = 0;

  const eventModel = (rows: Row[]) => ({
    create: async ({ data }: { data: Row }) => {
      if (rows.some((r) => r.eventHash === data.eventHash)) {
        throw new actual.Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
          meta: { target: ["eventHash"] },
        });
      }
      const row = { id: `row-${++seq}`, ...data };
      rows.push(row);
      return row;
    },
  });

  const client = {
    __tables: tables,
    __reset() {
      for (const rows of Object.values(tables)) rows.length = 0;
    },
    borrower: {
      upsert: async ({ where, create }: { where: Row; create: Row }) => {
        const existing = tables.borrower.find((b) => b.stellarAddress === where.stellarAddress);
        if (existing) return { ...existing };
        const row = {
          id: `borrower-${++seq}`,
          escrowBalance: "0",
          loanOutstanding: "0",
          totalDeposited: "0",
          totalDisbursed: "0",
          totalRepaid: "0",
          lastEventLedger: 0,
          ...create,
        };
        tables.borrower.push(row);
        return { ...row };
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = tables.borrower.find((b) => b.id === where.id)!;
        return Object.assign(row, data);
      },
    },
    escrowDeposit: eventModel(tables.escrowDeposit),
    escrowWithdrawal: eventModel(tables.escrowWithdrawal),
    loanDisbursement: eventModel(tables.loanDisbursement),
    loanRepayment: eventModel(tables.loanRepayment),
    eventIndexerState: {
      findUnique: async ({ where }: { where: Row }) =>
        tables.eventIndexerState.find((s) => s.key === where.key) ?? null,
      upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
        const existing = tables.eventIndexerState.find((s) => s.key === where.key);
        if (existing) return Object.assign(existing, update);
        tables.eventIndexerState.push({ ...create });
        return create;
      },
    },
    loanApplication: {
      findFirst: async ({ where }: { where: Row }) => {
        const loan = tables.loanApplication.find((l) => l.loanId === where.loanId);
        return loan ? { applicant: { stellarAddress: loan.stellarAddress } } : null;
      },
    },
  };

  return { ...actual, Prisma: actual.Prisma, PrismaClient: jest.fn(() => client) };
});

import { prisma } from "../services/db.js";
import {
  decodeFixtureEvents,
  loadContractEventFixture,
  replayContractEvents,
} from "../test-utils/contractEventReplay.js";

const db = prisma as unknown as { __tables: Record<string, any[]>; __reset: () => void };

/** One USDC in stroops, and the amounts the contract lifecycle test uses. */
const USDC = 10_000_000n;
const DEPOSIT = 10_000n * USDC;
const DISBURSED = 70_000n * USDC;
// 70,000 USDC plus one month at 8% a year, in the pool's fixed-point maths.
const OWED = (DISBURSED * (1_000_000_000n + (800n * 1_000_000_000n) / 120_000n)) / 1_000_000_000n;
/** The loan id the contract test requests, as hex. */
const LOAN_ID = "07".repeat(32);

const fixture = loadContractEventFixture("full-loan-lifecycle");
const decoded = decodeFixtureEvents(fixture);
const borrowerAddress = decoded.find((e) => e.topic === "deposit")!.borrower!;

function seedLoan(loanId: string, wallet: string) {
  db.__tables.loanApplication.push({ loanId, stellarAddress: wallet });
}

beforeEach(() => db.__reset());

describe("contract event fixture", () => {
  it("was generated from the contracts in the current fixture format", () => {
    expect(fixture.source).toMatch(/event_fixtures\.rs$/);
    expect(fixture.contracts.escrow).toMatch(/^C[A-Z2-7]{55}$/);
    expect(fixture.contracts.lendingPool).toMatch(/^C[A-Z2-7]{55}$/);
  });

  it("decodes the real event layouts into borrower, amount and loan id", () => {
    const deposits = decoded.filter((e) => e.topic === "deposit");
    const disbursements = decoded.filter((e) => e.topic === "disburse");
    const repayments = decoded.filter((e) => e.topic === "repay");

    expect(deposits).toHaveLength(3);
    for (const d of deposits) {
      expect(d.borrower).toMatch(/^[GC][A-Z2-7]{55}$/);
      expect(d.amount).toBe(DEPOSIT.toString());
    }
    expect(disbursements.map((d) => d.amount)).toEqual([(30_000n * USDC).toString(), (40_000n * USDC).toString()]);
    expect(disbursements.every((d) => d.borrower === null && d.loanId === LOAN_ID)).toBe(true);
    expect(repayments).toEqual([
      expect.objectContaining({ borrower: borrowerAddress, amount: OWED.toString(), loanId: LOAN_ID }),
    ]);
  });
});

describe("full loan lifecycle replay", () => {
  it("leaves the borrower's balances matching the on-chain lifecycle", async () => {
    seedLoan(LOAN_ID, borrowerAddress);

    await replayContractEvents(fixture);

    const { borrower, escrowDeposit, loanDisbursement, loanRepayment, escrowWithdrawal } = db.__tables;
    expect(borrower).toHaveLength(1);
    const row = borrower[0];
    expect(row.stellarAddress).toBe(borrowerAddress);
    expect(row.totalDeposited).toBe((3n * DEPOSIT).toString());
    expect(row.totalDisbursed).toBe(DISBURSED.toString());
    expect(row.totalRepaid).toBe(OWED.toString());
    // Repaid in full (with interest), so nothing is left outstanding.
    expect(row.loanOutstanding).toBe("0");
    expect(row.lastEventLedger).toBe(Math.max(...fixture.events.map((e) => e.ledger)));

    expect(escrowDeposit).toHaveLength(3);
    expect(loanDisbursement).toHaveLength(2);
    expect(loanRepayment).toHaveLength(1);
    expect(escrowWithdrawal).toHaveLength(0);
    expect(db.__tables.eventIndexerState[0]).toMatchObject({
      lastProcessedLedger: row.lastEventLedger,
    });
  });

  it("is idempotent when the same events are replayed", async () => {
    seedLoan(LOAN_ID, borrowerAddress);

    await replayContractEvents(fixture);
    const first = { ...db.__tables.borrower[0] };
    await replayContractEvents(fixture);

    expect(db.__tables.borrower[0]).toEqual(first);
    expect(db.__tables.escrowDeposit).toHaveLength(3);
    expect(db.__tables.loanRepayment).toHaveLength(1);
  });

  it("skips disbursements for a loan id the backend does not know", async () => {
    const warn = jest.fn();

    await replayContractEvents(fixture, { logger: { info: () => {}, warn, error: () => {} } });

    expect(db.__tables.loanDisbursement).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("skipping disburse"));
  });
});
