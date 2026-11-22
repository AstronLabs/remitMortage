// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Sanctions screening operator surface (issue #922), all under /api/admin:
 *   GET  /api/admin/sanctions/held     — accounts held for manual review
 *   POST /api/admin/sanctions/screen   — screen a party now (e.g. a newly
 *                                        onboarded contractor)
 *   POST /api/admin/sanctions/events   — a party's screening/decision history
 *   POST /api/admin/sanctions/decision — clear or reject a held account
 *   POST /api/admin/sanctions/sweep    — run the re-screening sweep now
 *
 * Parties are named in the request body, not the path, so the address never
 * lands in access logs.
 */

import { Router, Response } from "express";
import { requireAdmin, type AuthenticatedRequest } from "../middleware/auth.js";
import {
  SANCTIONS_PARTY_TYPES,
  type SanctionsPartyType,
} from "../services/sanctionsProvider.js";
import {
  SanctionsReviewError,
  isSanctionsScreeningEnabled,
  listHeldAccounts,
  listScreeningEvents,
  recordReviewDecision,
  runSanctionsSweep,
  screenParty,
} from "../services/sanctionsScreening.js";
import logger from "../utils/logger.js";

export const sanctionsAdminRouter = Router();

function parseParty(body: any): { partyType: SanctionsPartyType; address: string } | null {
  const partyType = String(body?.partyType ?? "").toUpperCase() as SanctionsPartyType;
  const address = String(body?.address ?? "").trim();
  if (!SANCTIONS_PARTY_TYPES.includes(partyType) || !address) return null;
  return { partyType, address };
}

function requireEnabled(res: Response): boolean {
  if (isSanctionsScreeningEnabled()) return true;
  res.status(409).json({ error: "sanctions_screening_disabled" });
  return false;
}

sanctionsAdminRouter.get("/sanctions/held", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limit = Number((req.query as any)?.limit ?? 100);
    return res.json({ held: await listHeldAccounts(Number.isFinite(limit) ? limit : 100) });
  } catch (err) {
    logger.error("[sanctions] Failed to list held accounts", { err });
    return res.status(500).json({ error: "sanctions_list_failed" });
  }
});

sanctionsAdminRouter.post("/sanctions/screen", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  if (!requireEnabled(res)) return;
  const party = parseParty(req.body);
  if (!party) return res.status(400).json({ error: "invalid_party" });
  try {
    const state = await screenParty(
      {
        ...party,
        name: typeof req.body?.name === "string" ? req.body.name : null,
        country: typeof req.body?.country === "string" ? req.body.country : null,
      },
      "manual"
    );
    return res.status(201).json(state);
  } catch (err) {
    logger.error("[sanctions] Manual screening failed", { err });
    return res.status(500).json({ error: "sanctions_screen_failed" });
  }
});

sanctionsAdminRouter.post("/sanctions/events", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const party = parseParty(req.body);
  if (!party) return res.status(400).json({ error: "invalid_party" });
  try {
    return res.json({ events: await listScreeningEvents(party.partyType, party.address) });
  } catch (err) {
    logger.error("[sanctions] Failed to read screening history", { err });
    return res.status(500).json({ error: "sanctions_events_failed" });
  }
});

sanctionsAdminRouter.post("/sanctions/decision", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const party = parseParty(req.body);
  if (!party) return res.status(400).json({ error: "invalid_party" });
  const reviewer = req.user?.walletAddress;
  if (!reviewer) return res.status(401).json({ error: "unauthorized" });
  try {
    const state = await recordReviewDecision({
      ...party,
      decision: req.body?.decision,
      reviewer,
      note: String(req.body?.note ?? ""),
    });
    return res.json(state);
  } catch (err) {
    if (err instanceof SanctionsReviewError) {
      const status = err.code === "not_found" ? 404 : err.code === "not_held" ? 409 : 400;
      return res.status(status).json({ error: err.code, message: err.message });
    }
    logger.error("[sanctions] Failed to record review decision", { err });
    return res.status(500).json({ error: "sanctions_decision_failed" });
  }
});

sanctionsAdminRouter.post("/sanctions/sweep", requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  if (!requireEnabled(res)) return;
  try {
    return res.json(await runSanctionsSweep());
  } catch (err) {
    logger.error("[sanctions] Manual sweep failed", { err });
    return res.status(500).json({ error: "sanctions_sweep_failed" });
  }
});
