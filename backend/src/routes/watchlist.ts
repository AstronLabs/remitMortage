// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Investor watchlist for upcoming loan offerings (issue #799). Mounted at
 * `/api/watchlist` with `authMiddleware` applied at the mount point in
 * index.ts, so every route is scoped to the verified `req.user.walletAddress`
 * — an investor can only ever read or change their own watches.
 */

import { Router, Response } from "express";
import logger from "../utils/logger.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import {
  OfferingWatchError,
  listUpcomingOfferings,
  listWatchlist,
  unwatchOffering,
  watchOffering,
} from "../services/offeringWatchlist.js";

export const watchlistRouter = Router();

/** GET /api/watchlist — the caller's watchlist, including offerings that have since opened. */
watchlistRouter.get("/", async (req: AuthenticatedRequest, res: Response) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    return res.json({ watchlist: await listWatchlist(walletAddress) });
  } catch (error) {
    logger.error("[watchlist] Failed to list watchlist", { error });
    return res.status(500).json({ error: "watchlist_unavailable" });
  }
});

/** GET /api/watchlist/upcoming — offerings not yet open for investment, flagged with whether the caller watches each. */
watchlistRouter.get("/upcoming", async (req: AuthenticatedRequest, res: Response) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    return res.json({ offerings: await listUpcomingOfferings(walletAddress) });
  } catch (error) {
    logger.error("[watchlist] Failed to list upcoming offerings", { error });
    return res.status(500).json({ error: "watchlist_unavailable" });
  }
});

/** PUT /api/watchlist/:loanId — watch an upcoming offering (idempotent). */
watchlistRouter.put("/:loanId", async (req: AuthenticatedRequest, res: Response) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    await watchOffering(walletAddress, String(req.params.loanId));
    return res.status(204).end();
  } catch (error) {
    if (error instanceof OfferingWatchError) {
      const status = error.code === "offering_not_found" ? 404 : 409;
      return res.status(status).json({ error: error.code, message: error.message });
    }
    logger.error("[watchlist] Failed to watch offering", { error });
    return res.status(500).json({ error: "watchlist_unavailable" });
  }
});

/** DELETE /api/watchlist/:loanId — stop watching (idempotent). */
watchlistRouter.delete("/:loanId", async (req: AuthenticatedRequest, res: Response) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    await unwatchOffering(walletAddress, String(req.params.loanId));
    return res.status(204).end();
  } catch (error) {
    logger.error("[watchlist] Failed to unwatch offering", { error });
    return res.status(500).json({ error: "watchlist_unavailable" });
  }
});
