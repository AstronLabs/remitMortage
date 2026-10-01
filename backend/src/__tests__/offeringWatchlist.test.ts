// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Unit tests for the investor offering watchlist (issue #799).
 *
 * Acceptance criteria under test:
 * 1. An investor can watch an upcoming offering and see it in a dedicated
 *    watchlist view.
 * 2. A watching investor receives a notification when the watched offering
 *    opens for investment.
 */

interface Loan {
  id: string;
  status: string;
  principal: number;
  interestRateBps: number;
  createdAt: Date;
  deletedAt: Date | null;
}
interface Watch {
  id: string;
  investorAddress: string;
  loanApplicationId: string;
  createdAt: Date;
  notifiedAt: Date | null;
}

const loans = new Map<string, Loan>();
let watches: Watch[] = [];
const createInAppNotificationMock = jest.fn();

function loanFor(watch: Watch) {
  return loans.get(watch.loanApplicationId)!;
}

jest.mock("../services/db.js", () => ({
  createInAppNotification: (...args: unknown[]) => createInAppNotificationMock(...args),
  prisma: {
    loanApplication: {
      findFirst: jest.fn(async ({ where }: any) => {
        const loan = loans.get(where.id);
        return loan && loan.deletedAt === null ? loan : null;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        Array.from(loans.values()).filter(
          (l) => l.status === where.status && l.deletedAt === null
        )
      ),
    },
    offeringWatch: {
      findMany: jest.fn(async ({ where, include }: any) => {
        let result = watches.filter((w) => {
          if (where.investorAddress && w.investorAddress !== where.investorAddress) return false;
          if (typeof where.loanApplicationId === "string" && w.loanApplicationId !== where.loanApplicationId) {
            return false;
          }
          if (where.loanApplicationId?.in && !where.loanApplicationId.in.includes(w.loanApplicationId)) {
            return false;
          }
          if (where.notifiedAt === null && w.notifiedAt !== null) return false;
          return true;
        });
        result = result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return include ? result.map((w) => ({ ...w, loanApplication: loanFor(w) })) : result;
      }),
      upsert: jest.fn(async ({ where, create }: any) => {
        const key = where.investorAddress_loanApplicationId;
        const existing = watches.find(
          (w) =>
            w.investorAddress === key.investorAddress &&
            w.loanApplicationId === key.loanApplicationId
        );
        if (existing) return existing;
        const watch: Watch = {
          id: `watch-${watches.length + 1}`,
          createdAt: new Date(),
          notifiedAt: null,
          ...create,
        };
        watches.push(watch);
        return watch;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const before = watches.length;
        watches = watches.filter(
          (w) =>
            !(
              w.investorAddress === where.investorAddress &&
              w.loanApplicationId === where.loanApplicationId
            )
        );
        return { count: before - watches.length };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const watch = watches.find((w) => w.id === where.id)!;
        Object.assign(watch, data);
        return watch;
      }),
    },
  },
}));

jest.mock("../utils/logger.js", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

import {
  OfferingWatchError,
  listUpcomingOfferings,
  listWatchlist,
  notifyWatchersOfOpenedOffering,
  offeringStateForStatus,
  unwatchOffering,
  watchOffering,
} from "../services/offeringWatchlist.js";

const ALICE = "GALICE";
const BOB = "GBOB";

function addLoan(id: string, status = "Pending", overrides: Partial<Loan> = {}) {
  loans.set(id, {
    id,
    status,
    principal: 50000,
    interestRateBps: 850,
    createdAt: new Date(),
    deletedAt: null,
    ...overrides,
  });
}

beforeEach(() => {
  loans.clear();
  watches = [];
  jest.clearAllMocks();
  createInAppNotificationMock.mockResolvedValue({});
});

describe("watchOffering / unwatchOffering (issue #799)", () => {
  it("lets an investor watch an upcoming (Pending) offering", async () => {
    addLoan("loan-1");
    await watchOffering(ALICE, "loan-1");

    expect(watches).toHaveLength(1);
    expect(watches[0]).toMatchObject({ investorAddress: ALICE, loanApplicationId: "loan-1" });
  });

  it("is idempotent: watching twice keeps a single watch", async () => {
    addLoan("loan-1");
    await watchOffering(ALICE, "loan-1");
    await watchOffering(ALICE, "loan-1");
    expect(watches).toHaveLength(1);
  });

  it("rejects watching an unknown offering", async () => {
    await expect(watchOffering(ALICE, "missing")).rejects.toMatchObject({
      code: "offering_not_found",
    });
  });

  it.each(["Approved", "Disbursing", "Repaying", "Completed", "Rejected"])(
    "rejects watching an offering that is no longer upcoming (%s)",
    async (status) => {
      addLoan("loan-2", status);
      await expect(watchOffering(ALICE, "loan-2")).rejects.toBeInstanceOf(OfferingWatchError);
      await expect(watchOffering(ALICE, "loan-2")).rejects.toMatchObject({
        code: "offering_not_watchable",
      });
      expect(watches).toHaveLength(0);
    }
  );

  it("unwatch removes only the caller's watch", async () => {
    addLoan("loan-1");
    await watchOffering(ALICE, "loan-1");
    await watchOffering(BOB, "loan-1");

    expect(await unwatchOffering(ALICE, "loan-1")).toBe(true);
    expect(watches.map((w) => w.investorAddress)).toEqual([BOB]);
  });

  it("unwatching something not watched is a harmless no-op", async () => {
    expect(await unwatchOffering(ALICE, "loan-1")).toBe(false);
  });
});

describe("listUpcomingOfferings / listWatchlist (dedicated watchlist view)", () => {
  it("lists only Pending offerings, flagging which the caller watches, without borrower identity", async () => {
    addLoan("loan-pending-a");
    addLoan("loan-pending-b");
    addLoan("loan-open", "Disbursing");
    await watchOffering(ALICE, "loan-pending-a");

    const offerings = await listUpcomingOfferings(ALICE);

    expect(offerings.map((o) => o.id).sort()).toEqual(["loan-pending-a", "loan-pending-b"]);
    expect(offerings.find((o) => o.id === "loan-pending-a")?.watched).toBe(true);
    expect(offerings.find((o) => o.id === "loan-pending-b")?.watched).toBe(false);
    expect(Object.keys(offerings[0]).sort()).toEqual(
      ["createdAt", "id", "interestRateBps", "principal", "watched"].sort()
    );
  });

  it("shows the caller's watchlist with each offering's current state", async () => {
    addLoan("loan-1");
    await watchOffering(ALICE, "loan-1");
    await watchOffering(BOB, "loan-1");

    let list = await listWatchlist(ALICE);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ loanId: "loan-1", state: "upcoming", notifiedAt: null });

    loans.get("loan-1")!.status = "Disbursing";
    list = await listWatchlist(ALICE);
    expect(list[0].state).toBe("open");
  });

  it("maps loan statuses onto upcoming / open / closed", () => {
    expect(offeringStateForStatus("Pending")).toBe("upcoming");
    expect(offeringStateForStatus("Approved")).toBe("open");
    expect(offeringStateForStatus("Disbursing")).toBe("open");
    expect(offeringStateForStatus("Rejected")).toBe("closed");
  });
});

describe("notifyWatchersOfOpenedOffering (notification on offering-open transition)", () => {
  it("notifies every watching investor once the offering opens", async () => {
    addLoan("loan-1", "Pending", { principal: 75000, interestRateBps: 900 });
    await watchOffering(ALICE, "loan-1");
    await watchOffering(BOB, "loan-1");

    const notified = await notifyWatchersOfOpenedOffering("loan-1");

    expect(notified).toBe(2);
    expect(createInAppNotificationMock).toHaveBeenCalledTimes(2);
    expect(createInAppNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        walletAddress: ALICE,
        title: "Watched offering is now open",
        message: expect.stringContaining("$75,000 at 9.00% APR"),
        metadata: expect.objectContaining({ type: "OFFERING_OPENED", loanId: "loan-1" }),
      })
    );
    expect(watches.every((w) => w.notifiedAt instanceof Date)).toBe(true);
  });

  it("does not notify investors watching a different offering", async () => {
    addLoan("loan-1");
    addLoan("loan-2");
    await watchOffering(ALICE, "loan-1");
    await watchOffering(BOB, "loan-2");

    await notifyWatchersOfOpenedOffering("loan-1");

    expect(createInAppNotificationMock).toHaveBeenCalledTimes(1);
    expect(createInAppNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: ALICE })
    );
  });

  it("never notifies a watcher twice for the same offering", async () => {
    addLoan("loan-1");
    await watchOffering(ALICE, "loan-1");

    await notifyWatchersOfOpenedOffering("loan-1");
    const second = await notifyWatchersOfOpenedOffering("loan-1");

    expect(second).toBe(0);
    expect(createInAppNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("does not notify an investor who unwatched before the offering opened", async () => {
    addLoan("loan-1");
    await watchOffering(ALICE, "loan-1");
    await unwatchOffering(ALICE, "loan-1");

    expect(await notifyWatchersOfOpenedOffering("loan-1")).toBe(0);
    expect(createInAppNotificationMock).not.toHaveBeenCalled();
  });

  it("keeps notifying other watchers when one notification fails, leaving the failed one retryable", async () => {
    addLoan("loan-1");
    await watchOffering(ALICE, "loan-1");
    await watchOffering(BOB, "loan-1");
    createInAppNotificationMock
      .mockRejectedValueOnce(new Error("db hiccup"))
      .mockResolvedValue({});

    const notified = await notifyWatchersOfOpenedOffering("loan-1");

    expect(notified).toBe(1);
    const pending = watches.filter((w) => w.notifiedAt === null);
    expect(pending).toHaveLength(1);

    // A retry picks up only the watcher that was missed.
    expect(await notifyWatchersOfOpenedOffering("loan-1")).toBe(1);
  });

  it("never throws, so it cannot fail the approval that triggers it", async () => {
    const { prisma } = jest.requireMock("../services/db.js") as any;
    prisma.offeringWatch.findMany.mockRejectedValueOnce(new Error("db down"));

    await expect(notifyWatchersOfOpenedOffering("loan-1")).resolves.toBe(0);
  });
});
