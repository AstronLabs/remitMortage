// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth.js";
import {
  listActiveSessions,
  revokeOtherSessions,
  revokeSession,
} from "../services/userSessions.js";
import { lookupErrorCode } from "../errors/catalog.js";

export const sessionsRouter = Router();

sessionsRouter.get("/", (req: AuthenticatedRequest, res: Response) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) {
    const err = lookupErrorCode("UNAUTHORIZED")!;
    return res.status(err.httpStatus).json({ error: err.code, code: err.code, message: err.description });
  }
  const active = listActiveSessions(walletAddress, req.user?.sessionId);
  return res.status(200).json({ sessions: active });
});

sessionsRouter.post("/revoke-others", (req: AuthenticatedRequest, res: Response) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) {
    const err = lookupErrorCode("UNAUTHORIZED")!;
    return res.status(err.httpStatus).json({ error: err.code, code: err.code, message: err.description });
  }
  const result = revokeOtherSessions(walletAddress, req.user?.sessionId);
  return res.status(200).json(result);
});

sessionsRouter.delete("/", (req: AuthenticatedRequest, res: Response) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) {
    const err = lookupErrorCode("UNAUTHORIZED")!;
    return res.status(err.httpStatus).json({ error: err.code, code: err.code, message: err.description });
  }
  const result = revokeOtherSessions(walletAddress, req.user?.sessionId);
  return res.status(200).json(result);
});

sessionsRouter.delete("/:sessionId", (req: AuthenticatedRequest, res: Response) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) {
    const err = lookupErrorCode("UNAUTHORIZED")!;
    return res.status(err.httpStatus).json({ error: err.code, code: err.code, message: err.description });
  }
  const outcome = revokeSession(walletAddress, String(req.params.sessionId));
  if (!outcome.ok) {
    const code = outcome.reason === "forbidden" ? "FORBIDDEN" : "SESSION_NOT_FOUND";
    const err = lookupErrorCode(code)!;
    return res.status(err.httpStatus).json({
      error: err.code,
      code: err.code,
      message: err.description,
      remediation: err.remediation,
    });
  }
  return res.status(200).json({ revoked: true, sessionId: outcome.session.sessionId });
});
