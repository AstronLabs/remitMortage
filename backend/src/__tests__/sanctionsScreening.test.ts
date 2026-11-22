// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Unit tests for sanctions screening at onboarding and on a schedule
 * (issue #922).
 *
 * Covered: clear, potential-match and confirmed-match outcomes; a held account
 * waiting for manual review rather than being rejected; recorded review
 * decisions; provider outages; and the re-screening sweep, including the
 * list-update trigger.
 */

const DAY = 24 * 60 * 60 * 1000;

let screenings: any[] = [];
let events: any[] = [];
const logAuditMock = jest.fn();

jest.mock("../services/audit.js", () => ({
  logAudit: (...args: unknown[]) => logAuditMock(...args),
}));

jest.mock("../utils/crypto.js", () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ""),
}));

jest.mock("../services/db.js", () => ({
  prisma: {
    sanctionsScreening: {
      findUnique: jest.fn(async ({ where }: any) => {
        const k = where.partyType_partyAddress;
        return screenings.find((r) => r.partyType === k.partyType && r.partyAddress === k.partyAddress) ?? null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `s${screenings.length + 1}`,
          status: "PENDING",
          matchLevel: null,
          matchFingerprint: null,
          reviewedFingerprint: null,
          subjectNameEnc: null,
          subjectCountry: null,
          listVersion: null,
          lastScreenedAt: null,
          lastError: null,
          updatedAt: new Date(),
          ...data,
        };
        screenings.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = screenings.find((r) => r.id === where.id)!;
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
      // The sweep re-checks every candidate itself, so the mock only needs to
      // honour the filters the service relies on for correctness.
      findMany: jest.fn(async ({ where }: any) => {
        if (where?.status === "HELD") return screenings.filter((r) => r.status === "HELD");
        return screenings.filter((r) => r.status !== "REJECTED");
      }),
    },
    sanctionsScreeningEvent: {
      create: jest.fn(async ({ data }: any) => {
        events.push({ id: `e${events.length + 1}`, createdAt: new Date(), ...data });
        return data;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        events.filter((e) => e.partyType === where.partyType && e.partyAddress === where.partyAddress)
      ),
    },
  },
}));

import {
  SanctionsHoldError,
  SanctionsReviewError,
  assertSanctionsClear,
  decideStatus,
  isDueForRescreen,
  listHeldAccounts,
  recordReviewDecision,
  runSanctionsSweep,
  screenOnboardedParty,
  screenParty,
} from "../services/sanctionsScreening.js";
import {
  setSanctionsProvider,
  type SanctionsProvider,
  type SanctionsScreeningResult,
} from "../services/sanctionsProvider.js";

const ADDR = "GAPPLICANTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const APPLICANT = { partyType: "APPLICANT" as const, address: ADDR, name: "Jane Roe" };

function result(over: Partial<SanctionsScreeningResult> = {}): SanctionsScreeningResult {
  return {
    outcome: "clear",
    matches: [],
    listVersion: "v1",
    providerReference: "ref-1",
    providerName: "test_provider",
    ...over,
  };
}

const potential = (entryId = "entry-1") =>
  result({ outcome: "potential_match", matches: [{ entryId, listName: "OFAC", score: 82 }] });
const confirmed = () =>
  result({ outcome: "confirmed_match", matches: [{ entryId: "entry-9", listName: "OFAC", score: 100 }] });

/** A provider whose answer and list version the test controls. */
function provider(initial: SanctionsScreeningResult | Error, listVersion: string | null = "v1") {
  const state = { next: initial as SanctionsScreeningResult | Error, listVersion, calls: [] as any[] };
  const impl: SanctionsProvider = {
    async screen(request) {
      state.calls.push(request);
      if (state.next instanceof Error) throw state.next;
      return state.next;
    },
    async getListVersion() {
      return state.listVersion;
    },
  };
  setSanctionsProvider(impl);
  return state;
}

beforeEach(() => {
  screenings = [];
  events = [];
  logAuditMock.mockReset().mockResolvedValue(undefined);
  process.env.SANCTIONS_SCREENING_ENABLED = "true";
  delete process.env.SANCTIONS_RESCREEN_INTERVAL_DAYS;
});

afterAll(() => {
  delete process.env.SANCTIONS_SCREENING_ENABLED;
});

describe("onboarding screening outcomes", () => {
  it("clears a party with no match and lets them through the gate", async () => {
    provider(result());
    const state = await screenOnboardedParty(APPLICANT);

    expect(state).toMatchObject({ status: "CLEAR", matchLevel: null, providerError: false });
    await expect(assertSanctionsClear("APPLICANT", ADDR)).resolves.toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "screened", trigger: "onboarding", outcome: "clear", status: "CLEAR" });
  });

  it("holds a potential match for manual review instead of rejecting", async () => {
    provider(potential());
    const state = await screenOnboardedParty(APPLICANT);

    expect(state).toMatchObject({ status: "HELD", matchLevel: "potential" });
    expect(state?.status).not.toBe("REJECTED");
    expect(events[0]).toMatchObject({ kind: "held", outcome: "potential_match", status: "HELD" });
    expect(events[0].detail.matches[0].entryId).toBe("entry-1");
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "sanctions.hold" }));
    expect(await listHeldAccounts()).toHaveLength(1);
  });

  it("holds a confirmed match for manual review too, flagged as confirmed", async () => {
    provider(confirmed());
    const state = await screenOnboardedParty(APPLICANT);

    expect(state).toMatchObject({ status: "HELD", matchLevel: "confirmed" });
    expect(events[0]).toMatchObject({ kind: "held", outcome: "confirmed_match" });
  });

  it("blocks a held party at the gate without saying why", async () => {
    provider(potential());
    await screenOnboardedParty(APPLICANT);

    const err = await assertSanctionsClear("APPLICANT", ADDR).catch((e) => e);
    expect(err).toBeInstanceOf(SanctionsHoldError);
    expect(err.httpStatus).toBe(403);
    expect(err.code).toBe("account_under_review");
    expect(err.message).not.toMatch(/sanction|match|list/i);
  });

  it("stores the name encrypted and sends it to the provider", async () => {
    const p = provider(result());
    await screenOnboardedParty(APPLICANT);

    expect(p.calls[0]).toMatchObject({ partyType: "APPLICANT", address: ADDR, name: "Jane Roe" });
    expect(screenings[0].subjectNameEnc).toBe("enc:Jane Roe");
  });

  it("does nothing while screening is disabled", async () => {
    process.env.SANCTIONS_SCREENING_ENABLED = "false";
    const p = provider(result());

    expect(await screenOnboardedParty(APPLICANT)).toBeNull();
    await expect(assertSanctionsClear("APPLICANT", ADDR)).resolves.toBeUndefined();
    expect(p.calls).toHaveLength(0);
    expect(screenings).toHaveLength(0);
  });
});

describe("provider outages", () => {
  it("leaves a new party PENDING (not cleared) and blocks them", async () => {
    provider(new Error("timeout"));
    const state = await screenOnboardedParty(APPLICANT);

    expect(state).toMatchObject({ status: "PENDING", providerError: true });
    expect(screenings[0].lastError).toBe("timeout");
    expect(events[0]).toMatchObject({ kind: "provider_error", note: "timeout" });
    await expect(assertSanctionsClear("APPLICANT", ADDR)).rejects.toBeInstanceOf(SanctionsHoldError);
  });

  it("treats an unconfigured provider as an outage, never as clear", async () => {
    const { NullSanctionsProvider } = await import("../services/sanctionsProvider.js");
    setSanctionsProvider(new NullSanctionsProvider());
    const state = await screenOnboardedParty(APPLICANT);

    expect(state?.status).toBe("PENDING");
    expect(state?.providerError).toBe(true);
  });

  it("keeps an already-screened party's standing when a re-screen hits an outage", async () => {
    const p = provider(result());
    await screenParty(APPLICANT);
    p.next = new Error("provider down");
    const state = await screenParty(APPLICANT, "scheduled");

    expect(state).toMatchObject({ status: "CLEAR", providerError: true });
    await expect(assertSanctionsClear("APPLICANT", ADDR)).resolves.toBeUndefined();
  });

  it("clears a pending party once the provider recovers", async () => {
    const p = provider(new Error("down"));
    await screenParty(APPLICANT);
    p.next = result();
    const sweep = await runSanctionsSweep(new Date());

    expect(sweep).toMatchObject({ rescreened: 1, providerErrors: 0 });
    expect(screenings[0].status).toBe("CLEAR");
  });

  it("counts provider errors in a sweep without stopping it", async () => {
    const p = provider(result());
    await screenParty(APPLICANT);
    await screenParty({ partyType: "INVESTOR", address: "GINVESTORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", name: "Inv" });
    p.listVersion = "v2";
    p.next = new Error("provider down");
    const sweep = await runSanctionsSweep(new Date());

    expect(sweep.rescreened).toBe(2);
    expect(sweep.providerErrors).toBe(2);
    expect(screenings.every((r) => r.status === "CLEAR")).toBe(true);
  });
});

describe("manual review decisions", () => {
  async function held() {
    const p = provider(potential());
    await screenParty(APPLICANT);
    return p;
  }

  it("releases a cleared account and records who decided and why", async () => {
    await held();
    const state = await recordReviewDecision({
      partyType: "APPLICANT",
      address: ADDR,
      decision: "clear",
      reviewer: "GREVIEWER",
      note: "Different date of birth; false positive",
    });

    expect(state.status).toBe("CLEAR");
    await expect(assertSanctionsClear("APPLICANT", ADDR)).resolves.toBeUndefined();
    const decision = events.find((e) => e.kind === "review_decision");
    expect(decision).toMatchObject({
      outcome: "clear",
      actor: "GREVIEWER",
      note: "Different date of birth; false positive",
      status: "CLEAR",
    });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "sanctions.review.clear", actorAddress: "GREVIEWER" })
    );
  });

  it("makes a rejection final, even if a later screening comes back clear", async () => {
    const p = await held();
    await recordReviewDecision({
      partyType: "APPLICANT",
      address: ADDR,
      decision: "reject",
      reviewer: "GREVIEWER",
      note: "Identity confirmed against the list entry",
    });
    p.next = result();
    const state = await screenParty(APPLICANT, "scheduled");

    expect(state.status).toBe("REJECTED");
    await expect(assertSanctionsClear("APPLICANT", ADDR)).rejects.toBeInstanceOf(SanctionsHoldError);
  });

  it("requires a note and a held account", async () => {
    await held();
    await expect(
      recordReviewDecision({ partyType: "APPLICANT", address: ADDR, decision: "clear", reviewer: "R", note: "  " })
    ).rejects.toMatchObject({ code: "note_required" });
    await expect(
      recordReviewDecision({ partyType: "APPLICANT", address: "GNOBODY", decision: "clear", reviewer: "R", note: "x" })
    ).rejects.toMatchObject({ code: "not_found" });

    await recordReviewDecision({ partyType: "APPLICANT", address: ADDR, decision: "clear", reviewer: "R", note: "ok" });
    await expect(
      recordReviewDecision({ partyType: "APPLICANT", address: ADDR, decision: "clear", reviewer: "R", note: "again" })
    ).rejects.toBeInstanceOf(SanctionsReviewError);
  });

  it("does not hold the same cleared match again, but holds a different one", async () => {
    const p = await held();
    await recordReviewDecision({ partyType: "APPLICANT", address: ADDR, decision: "clear", reviewer: "R", note: "false positive" });

    // Same list entry on the next re-screen: stays clear.
    const again = await screenParty(APPLICANT, "scheduled");
    expect(again.status).toBe("CLEAR");

    // A new entry matches: held again.
    p.next = potential("entry-2");
    const other = await screenParty(APPLICANT, "scheduled");
    expect(other).toMatchObject({ status: "HELD", matchLevel: "potential" });
  });

  it("never lets an earlier clearance cover a confirmed match", async () => {
    const p = await held();
    await recordReviewDecision({ partyType: "APPLICANT", address: ADDR, decision: "clear", reviewer: "R", note: "false positive" });
    p.next = confirmed();

    expect((await screenParty(APPLICANT, "scheduled")).status).toBe("HELD");
  });

  it("keeps a held account held when the match later disappears", async () => {
    const p = await held();
    p.next = result();
    const state = await screenParty(APPLICANT, "scheduled");

    expect(state.status).toBe("HELD");
    expect(state.matchLevel).toBe("potential");
  });
});

describe("scheduled and list-update re-screening", () => {
  const NOW = new Date("2027-03-01T00:00:00Z");

  it("re-screens everyone when the lists are updated, even if recently screened", async () => {
    const p = provider(result());
    await screenParty(APPLICANT);
    expect(screenings[0].listVersion).toBe("v1");

    p.listVersion = "v2";
    p.next = potential();
    const sweep = await runSanctionsSweep(new Date());

    expect(sweep).toMatchObject({ rescreened: 1, nowHeld: 1, listVersion: "v2" });
    expect(screenings[0]).toMatchObject({ status: "HELD", listVersion: "v1" });
    expect(events.filter((e) => e.trigger === "list_update")).toHaveLength(1);
  });

  it("re-screens a party not checked within the interval", async () => {
    const p = provider(result());
    await screenParty(APPLICANT);
    screenings[0].lastScreenedAt = new Date(NOW.getTime() - 8 * DAY);

    const sweep = await runSanctionsSweep(NOW);
    expect(sweep.rescreened).toBe(1);
    expect(p.calls).toHaveLength(2);
    expect(events.filter((e) => e.trigger === "scheduled")).toHaveLength(1);
  });

  it("leaves a recently screened party on the current lists alone", async () => {
    const p = provider(result());
    await screenParty(APPLICANT);

    const sweep = await runSanctionsSweep(new Date());
    expect(sweep.rescreened).toBe(0);
    expect(p.calls).toHaveLength(1);
  });

  it("does not re-screen a rejected party", async () => {
    provider(potential());
    await screenParty(APPLICANT);
    await recordReviewDecision({ partyType: "APPLICANT", address: ADDR, decision: "reject", reviewer: "R", note: "confirmed" });

    expect((await runSanctionsSweep(new Date(NOW.getTime() + 30 * DAY))).rescreened).toBe(0);
  });

  it("is a no-op while screening is disabled", async () => {
    process.env.SANCTIONS_SCREENING_ENABLED = "false";
    const p = provider(result());
    expect(await runSanctionsSweep(NOW)).toMatchObject({ rescreened: 0 });
    expect(p.calls).toHaveLength(0);
  });
});

describe("pure rules", () => {
  const base = { status: "CLEAR" as const, reviewedFingerprint: null };

  it("decideStatus maps each outcome", () => {
    expect(decideStatus(null, result())).toMatchObject({ status: "CLEAR" });
    expect(decideStatus(null, potential())).toMatchObject({ status: "HELD", matchLevel: "potential" });
    expect(decideStatus(base, confirmed())).toMatchObject({ status: "HELD", matchLevel: "confirmed" });
    expect(decideStatus({ status: "REJECTED", reviewedFingerprint: null }, result())).toMatchObject({
      status: "REJECTED",
    });
  });

  it("isDueForRescreen covers every trigger", () => {
    const now = new Date("2027-03-01T00:00:00Z");
    const fresh = { status: "CLEAR" as const, lastScreenedAt: new Date(now.getTime() - DAY), listVersion: "v1" };

    expect(isDueForRescreen(fresh, now, "v1", 7).due).toBe(false);
    expect(isDueForRescreen(fresh, now, "v2", 7)).toEqual({ due: true, trigger: "list_update" });
    expect(isDueForRescreen(fresh, now, null, 7).due).toBe(false);
    expect(isDueForRescreen({ ...fresh, lastScreenedAt: new Date(now.getTime() - 8 * DAY) }, now, "v1", 7)).toEqual({
      due: true,
      trigger: "scheduled",
    });
    expect(isDueForRescreen({ ...fresh, status: "PENDING" }, now, "v1", 7).due).toBe(true);
    expect(isDueForRescreen({ ...fresh, status: "REJECTED" as any }, now, "v2", 7).due).toBe(false);
  });
});
