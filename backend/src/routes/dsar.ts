// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router, Request, Response, NextFunction } from "express";
import {
  checkApproachingDsarDeadlines,
  createDsarRequest,
  DsarStatus,
  DsarType,
  getDsarRequest,
  listDsarRequests,
  transitionDsarStatus,
} from "../services/dsarTracker.js";
import { AppError } from "../errors/catalog.js";
import logger from "../utils/logger.js";

const VALID_TYPES = new Set<DsarType>([
  "ACCESS",
  "ERASURE",
  "RECTIFICATION",
  "PORTABILITY",
  "RESTRICTION",
]);
const VALID_STATUSES = new Set<DsarStatus>([
  "RECEIVED",
  "IDENTITY_VERIFIED",
  "IN_PROGRESS",
  "COMPLETED",
]);

export const dsarAdminRouter = Router();

dsarAdminRouter.post("/", (req: Request, res: Response, next: NextFunction) => {
  try {
    const { type, requester, receivedAt, statutoryDays, notes } = req.body ?? {};
    if (!VALID_TYPES.has(type)) {
      throw new AppError("VALIDATION_ERROR", "type must be a valid DSAR type");
    }
    const created = createDsarRequest({
      type,
      requester,
      receivedAt: receivedAt ?? new Date().toISOString(),
      statutoryDays,
      notes,
    });
    return res.status(201).json(created);
  } catch (err) {
    return next(err);
  }
});

dsarAdminRouter.get("/", (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status ? String(req.query.status) : undefined;
    if (status && !VALID_STATUSES.has(status as DsarStatus)) {
      throw new AppError("VALIDATION_ERROR", "Invalid DSAR status filter");
    }
    return res.status(200).json({ requests: listDsarRequests(status as DsarStatus | undefined) });
  } catch (err) {
    return next(err);
  }
});

dsarAdminRouter.get("/:id", (req: Request, res: Response, next: NextFunction) => {
  try {
    const record = getDsarRequest(String(req.params.id));
    if (!record) {
      throw new AppError("DSAR_NOT_FOUND");
    }
    return res.status(200).json(record);
  } catch (err) {
    return next(err);
  }
});

dsarAdminRouter.patch("/:id/status", (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status } = req.body ?? {};
    if (!VALID_STATUSES.has(status)) {
      throw new AppError("VALIDATION_ERROR", "status must be a valid DSAR status");
    }
    const updated = transitionDsarStatus(String(req.params.id), status);
    return res.status(200).json(updated);
  } catch (err) {
    return next(err);
  }
});

dsarAdminRouter.post("/check-deadlines", (req: Request, res: Response, next: NextFunction) => {
  try {
    const warningDays =
      typeof req.body?.warningDays === "number" ? req.body.warningDays : undefined;
    const alerts = checkApproachingDsarDeadlines({
      warningDays,
      notify: (alert) => {
        logger.warn("[dsar] Approaching statutory deadline", alert);
      },
    });
    return res.status(200).json({ alertedCount: alerts.length, alerts });
  } catch (err) {
    return next(err);
  }
});
