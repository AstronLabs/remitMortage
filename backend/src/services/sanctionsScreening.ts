// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Sanctions screening at onboarding and on a schedule (issue #922).
 *
 * Applicants, contractors and investors are screened against sanctions lists
 * through the configured provider when they are onboarded, and re-screened by
 * a recurring sweep — on a fixed interval, and whenever the provider reports
 * that its lists have been updated.
 *
 *   outcome            account status
 *   ─────────────────  ────────────────────────────────────────────────────
 *   clear              CLEAR
 *   potential_match    HELD   — held for manual review, never auto-rejected
 *   confirmed_match    HELD   — same, flagged "confirmed" for the reviewer
 *   provider outage    PENDING for a new party (fails closed until screened);
 *                      an already-screened party keeps its status
 *
 * A reviewer resolves a HELD account with {@link recordReviewDecision}: `clear`
 * releases it (the matched entries are remembered, so the same false positive
 * is not held again on every re-screen) and `reject` makes the block final.
 * Every screening result and decision is written to an append-only event log.
 *
 * The whole feature is off unless SANCTIONS_SCREENING_ENABLED=true, so a
 * deployment without a provider is unaffected.
 *
 *   SANCTIONS_SCREENING_ENABLED         (default false)
 *   SANCTIONS_RESCREEN_INTERVAL_DAYS    (default 7)
 *   SANCTIONS_SWEEP_BATCH_SIZE          (default 200)
 */

import { createHash } from "crypto";
import { prisma } from "./db.js";
import { logAudit } from "./audit.js";
import { encrypt, decrypt } from "../utils/crypto.js";
import logger from "../utils/logger.js";
import {
  fetchSanctionsListVersion,
  requestSanctionsScreening,
  type SanctionsPartyType,
  type SanctionsScreeningResult,
} from "./sanctionsProvider.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type SanctionsStatus = "PENDING" | "CLEAR" | "HELD" | "REJECTED";
export type SanctionsTrigger = "onboarding" | "scheduled" | "list_update" | "manual";
export type SanctionsDecision = "clear" | "reject";

export interface SanctionsParty {
  partyType: SanctionsPartyType;
  address: string;
  name?: string | null;
  country?: string | null;
}

export interface SanctionsScreeningState {
  partyType: SanctionsPartyType;
  address: string;
  status: SanctionsStatus;
  matchLevel: "potential" | "confirmed" | null;
  lastScreenedAt: string | null;
  /** True when this call could not reach the provider. */
  providerError: boolean;
}

/**
 * Thrown by the gate when a party may not transact. The message is generic on
 * purpose: telling a party why they are held would tip them off to a
 * sanctions match, so the reason lives only in the review record.
 */
export class SanctionsHoldError extends Error {
  readonly code = "account_under_review";
  readonly httpStatus = 403;
  constructor(public readonly status: SanctionsStatus) {
    super("Your account is under review. Please contact support.");
  }
}

export function isSanctionsScreeningEnabled(): boolean {
  return process.env.SANCTIONS_SCREENING_ENABLED === "true";
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function getSanctionsConfig() {
  return {
    rescreenIntervalDays: positiveInt(process.env.SANCTIONS_RESCREEN_INTERVAL_DAYS, 7),
    sweepBatchSize: positiveInt(process.env.SANCTIONS_SWEEP_BATCH_SIZE, 200),
  };
}

/** Stable digest of the list entries a result matched. */
function matchFingerprint(result: SanctionsScreeningResult): string | null {
  const ids = result.matches.map((m) => m.entryId).filter(Boolean).sort();
  if (ids.length === 0) return null;
  return createHash("sha256").update(ids.join("|")).digest("hex");
}

/**
 * Pure decision for one provider result: the status and match level the party
 * ends up with, given what it had before. Kept separate from persistence so
 * the rules can be read (and tested) in one place.
 */
export function decideStatus(
  previous: { status: SanctionsStatus; reviewedFingerprint: string | null } | null,
  result: SanctionsScreeningResult
): { status: SanctionsStatus; matchLevel: "potential" | "confirmed" | null; reviewedAgain: boolean } {
  // A final rejection is only ever lifted by a person.
  if (previous?.status === "REJECTED") {
    return { status: "REJECTED", matchLevel: null, reviewedAgain: false };
  }

  if (result.outcome === "confirmed_match") {
    // A reviewer's earlier clearance never covers a confirmed match.
    return { status: "HELD", matchLevel: "confirmed", reviewedAgain: false };
  }

  if (result.outcome === "potential_match") {
    const fingerprint = matchFingerprint(result);
    if (
      previous?.status === "CLEAR" &&
      fingerprint !== null &&
      previous.reviewedFingerprint === fingerprint
    ) {
      // The same entries a reviewer already cleared: not held again.
      return { status: "CLEAR", matchLevel: null, reviewedAgain: true };
    }
    return { status: "HELD", matchLevel: "potential", reviewedAgain: false };
  }

  // clear. A held account stays held until a person decides: a list entry
  // vanishing is not a review.
  if (previous?.status === "HELD") {
    return { status: "HELD", matchLevel: null, reviewedAgain: false };
  }
  return { status: "CLEAR", matchLevel: null, reviewedAgain: false };
}

function toState(row: any, providerError = false): SanctionsScreeningState {
  return {
    partyType: row.partyType,
    address: row.partyAddress,
    status: row.status,
    matchLevel: row.matchLevel ?? null,
    lastScreenedAt: row.lastScreenedAt ? new Date(row.lastScreenedAt).toISOString() : null,
    providerError,
  };
}

async function recordEvent(row: any, event: {
  kind: "screened" | "held" | "provider_error" | "review_decision";
  trigger: SanctionsTrigger;
  outcome?: string | null;
  listVersion?: string | null;
  actor?: string | null;
  note?: string | null;
  detail?: unknown;
}) {
  await (prisma as any).sanctionsScreeningEvent.create({
    data: {
      screeningId: row.id,
      partyType: row.partyType,
      partyAddress: row.partyAddress,
      kind: event.kind,
      trigger: event.trigger,
      outcome: event.outcome ?? null,
      status: row.status,
      listVersion: event.listVersion ?? null,
      actor: event.actor ?? null,
      note: event.note ?? null,
      detail: event.detail ?? undefined,
    },
  });
}

/**
 * Screens one party and records the outcome. Never throws for a provider
 * problem: an outage is recorded and reported through `providerError`.
 */
export async function screenParty(
  party: SanctionsParty,
  trigger: SanctionsTrigger = "onboarding"
): Promise<SanctionsScreeningState> {
  const where = { partyType_partyAddress: { partyType: party.partyType, partyAddress: party.address } };
  const existing = await (prisma as any).sanctionsScreening.findUnique({ where });

  // Rescreens reuse the name stored at onboarding.
  const name =
    party.name ?? (existing?.subjectNameEnc ? decrypt(existing.subjectNameEnc) : null);
  const country = party.country ?? existing?.subjectCountry ?? null;

  const call = await requestSanctionsScreening({
    partyType: party.partyType,
    address: party.address,
    name,
    country,
  });

  const subject = {
    subjectNameEnc: name ? encrypt(name) : null,
    subjectCountry: country,
  };

  if (!call.ok) {
    // Fail closed for a party never successfully screened; leave a screened
    // party's standing alone and let the next sweep retry.
    const row = existing
      ? await (prisma as any).sanctionsScreening.update({
          where: { id: existing.id },
          data: { lastError: call.error, ...(name ? subject : {}) },
        })
      : await (prisma as any).sanctionsScreening.create({
          data: {
            partyType: party.partyType,
            partyAddress: party.address,
            status: "PENDING",
            lastError: call.error,
            ...subject,
          },
        });
    await recordEvent(row, { kind: "provider_error", trigger, note: call.error });
    logger.warn("[sanctions] Screening deferred: provider unavailable", {
      partyType: party.partyType,
      trigger,
    });
    return toState(row, true);
  }

  const { result } = call;
  const decision = decideStatus(existing, result);
  const fingerprint = matchFingerprint(result);
  // A held account that now screens clear stays held on its original match.
  const keepHeldMatch = decision.status === "HELD" && result.outcome === "clear";
  const data = {
    status: decision.status,
    matchLevel: keepHeldMatch ? existing.matchLevel : decision.matchLevel,
    matchFingerprint: keepHeldMatch ? existing.matchFingerprint : fingerprint,
    listVersion: result.listVersion,
    providerName: result.providerName,
    providerReference: result.providerReference,
    lastScreenedAt: new Date(),
    lastError: null,
    ...subject,
  };

  const row = existing
    ? await (prisma as any).sanctionsScreening.update({ where: { id: existing.id }, data })
    : await (prisma as any).sanctionsScreening.create({
        data: { partyType: party.partyType, partyAddress: party.address, ...data },
      });

  const holding = decision.status === "HELD" && result.outcome !== "clear";
  await recordEvent(row, {
    kind: holding ? "held" : "screened",
    trigger,
    outcome: result.outcome,
    listVersion: result.listVersion,
    note: decision.reviewedAgain ? "match previously cleared by a reviewer" : null,
    detail: result.matches.length ? { matches: result.matches } : undefined,
  });

  if (holding) {
    await logAudit({
      action: "sanctions.hold",
      metadata: {
        partyType: party.partyType,
        address: party.address,
        outcome: result.outcome,
        trigger,
      },
    });
  }

  return toState(row);
}

/** Screens a party that has just been onboarded. */
export async function screenOnboardedParty(party: SanctionsParty): Promise<SanctionsScreeningState | null> {
  if (!isSanctionsScreeningEnabled()) return null;
  return screenParty(party, "onboarding");
}

async function getScreeningState(
  partyType: SanctionsPartyType,
  address: string
): Promise<SanctionsScreeningState | null> {
  const row = await (prisma as any).sanctionsScreening.findUnique({
    where: { partyType_partyAddress: { partyType, partyAddress: address } },
  });
  return row ? toState(row) : null;
}

/**
 * Gate for actions a party must not take while held. A party with no record
 * (it predates screening) is screened on the spot. Anything but CLEAR blocks,
 * including PENDING: a party the provider could not check yet is not cleared.
 */
export async function assertSanctionsClear(
  partyType: SanctionsPartyType,
  address: string
): Promise<void> {
  if (!isSanctionsScreeningEnabled()) return;
  let state = await getScreeningState(partyType, address);
  if (!state) state = await screenParty({ partyType, address }, "onboarding");
  if (state.status !== "CLEAR") throw new SanctionsHoldError(state.status);
}

export interface ReviewDecisionInput {
  partyType: SanctionsPartyType;
  address: string;
  decision: SanctionsDecision;
  reviewer: string;
  note: string;
}

export class SanctionsReviewError extends Error {
  constructor(
    public readonly code: "not_found" | "not_held" | "note_required" | "invalid_decision",
    message: string
  ) {
    super(message);
  }
}

/**
 * Records a reviewer's decision on a HELD account. `clear` releases it and
 * remembers the matched entries; `reject` makes the block final. A written
 * note is mandatory so the decision can be defended later.
 */
export async function recordReviewDecision(input: ReviewDecisionInput): Promise<SanctionsScreeningState> {
  if (input.decision !== "clear" && input.decision !== "reject") {
    throw new SanctionsReviewError("invalid_decision", "decision must be 'clear' or 'reject'");
  }
  const note = (input.note ?? "").trim();
  if (!note) throw new SanctionsReviewError("note_required", "a review note is required");

  const existing = await (prisma as any).sanctionsScreening.findUnique({
    where: { partyType_partyAddress: { partyType: input.partyType, partyAddress: input.address } },
  });
  if (!existing) throw new SanctionsReviewError("not_found", "no screening record for this party");
  if (existing.status !== "HELD") {
    throw new SanctionsReviewError("not_held", "only a held account can be reviewed");
  }

  const clearing = input.decision === "clear";
  const row = await (prisma as any).sanctionsScreening.update({
    where: { id: existing.id },
    data: {
      status: clearing ? "CLEAR" : "REJECTED",
      matchLevel: null,
      reviewedFingerprint: clearing ? existing.matchFingerprint : existing.reviewedFingerprint,
      reviewedBy: input.reviewer,
      reviewedAt: new Date(),
      reviewNote: note,
    },
  });
  await recordEvent(row, {
    kind: "review_decision",
    trigger: "manual",
    outcome: input.decision,
    actor: input.reviewer,
    note,
  });
  await logAudit({
    action: `sanctions.review.${input.decision}`,
    actorAddress: input.reviewer,
    metadata: { partyType: input.partyType, address: input.address },
  });
  return toState(row);
}

export async function listHeldAccounts(limit = 100) {
  const rows = await (prisma as any).sanctionsScreening.findMany({
    where: { status: "HELD" },
    orderBy: { updatedAt: "asc" },
    take: Math.min(Math.max(limit, 1), 500),
  });
  return rows.map((row: any) => ({
    ...toState(row),
    listVersion: row.listVersion ?? null,
    providerName: row.providerName ?? null,
    heldSince: new Date(row.updatedAt).toISOString(),
  }));
}

export async function listScreeningEvents(partyType: SanctionsPartyType, address: string) {
  return (prisma as any).sanctionsScreeningEvent.findMany({
    where: { partyType, partyAddress: address },
    orderBy: { createdAt: "asc" },
  });
}

/** Whether a stored record needs another look. */
export function isDueForRescreen(
  record: { status: SanctionsStatus; lastScreenedAt: Date | string | null; listVersion: string | null },
  now: Date,
  currentListVersion: string | null,
  rescreenIntervalDays: number = getSanctionsConfig().rescreenIntervalDays
): { due: boolean; trigger: SanctionsTrigger } {
  // A final rejection is never re-screened.
  if (record.status === "REJECTED") return { due: false, trigger: "scheduled" };
  if (record.status === "PENDING" || !record.lastScreenedAt) {
    return { due: true, trigger: "scheduled" };
  }
  if (currentListVersion !== null && record.listVersion !== currentListVersion) {
    return { due: true, trigger: "list_update" };
  }
  const cutoff = now.getTime() - rescreenIntervalDays * DAY_MS;
  if (new Date(record.lastScreenedAt).getTime() <= cutoff) {
    return { due: true, trigger: "scheduled" };
  }
  return { due: false, trigger: "scheduled" };
}

export interface SanctionsSweepResult {
  rescreened: number;
  nowHeld: number;
  providerErrors: number;
  listVersion: string | null;
}

/**
 * Re-screens every record that is due: not yet successfully screened, screened
 * against an older version of the lists, or last screened longer ago than the
 * re-screen interval. One party's failure never stops the sweep, and a provider
 * outage leaves each party's standing as it was.
 */
export async function runSanctionsSweep(now: Date = new Date()): Promise<SanctionsSweepResult> {
  const result: SanctionsSweepResult = { rescreened: 0, nowHeld: 0, providerErrors: 0, listVersion: null };
  if (!isSanctionsScreeningEnabled()) return result;

  const config = getSanctionsConfig();
  const listVersion = await fetchSanctionsListVersion();
  result.listVersion = listVersion;
  const cutoff = new Date(now.getTime() - config.rescreenIntervalDays * DAY_MS);

  const candidates = await (prisma as any).sanctionsScreening.findMany({
    where: {
      status: { not: "REJECTED" },
      OR: [
        { status: "PENDING" },
        { lastScreenedAt: null },
        { lastScreenedAt: { lte: cutoff } },
        ...(listVersion !== null ? [{ listVersion: { not: listVersion } }] : []),
      ],
    },
    // Never-screened rows sort first so an outage backlog cannot starve them.
    orderBy: { lastScreenedAt: { sort: "asc", nulls: "first" } },
    take: config.sweepBatchSize,
  });

  for (const record of candidates) {
    const due = isDueForRescreen(record, now, listVersion, config.rescreenIntervalDays);
    if (!due.due) continue;
    try {
      const wasHeld = record.status === "HELD";
      const state = await screenParty(
        { partyType: record.partyType, address: record.partyAddress },
        due.trigger
      );
      result.rescreened += 1;
      if (state.providerError) result.providerErrors += 1;
      if (state.status === "HELD" && !wasHeld) result.nowHeld += 1;
    } catch (err) {
      result.providerErrors += 1;
      logger.error("[sanctions] Re-screen failed", {
        partyType: record.partyType,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

