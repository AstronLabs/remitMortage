// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router, Request, Response } from "express";
import { issueChallenge, requestAssistedToken, solveChallenge } from "../services/adaptiveCaptcha.js";
import { sourceFromRequest } from "../middleware/adaptiveCaptcha.js";

export const captchaRouter = Router();

/** Request a challenge for an action (also returned inline with captcha_required). */
captchaRouter.post("/challenge", (req: Request, res: Response) => {
  const action = req.body?.action;
  if (typeof action !== "string" || !action || action.length > 64) {
    return res.status(400).json({ error: "invalid_request", message: "action is required" });
  }
  return res.json({ challenge: issueChallenge({ action, source: sourceFromRequest(req) }) });
});

/** Submit an answer; a correct one returns a single-use token bound to the action. */
captchaRouter.post("/solve", (req: Request, res: Response) => {
  const { challengeId, answer } = req.body ?? {};
  if (typeof challengeId !== "string" || typeof answer !== "string") {
    return res.status(400).json({ error: "invalid_request", message: "challengeId and answer are required" });
  }
  const result = solveChallenge(challengeId, answer, sourceFromRequest(req));
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

/** Accessible fallback for users who cannot complete the challenge. */
captchaRouter.post("/assisted", (req: Request, res: Response) => {
  const { challengeId } = req.body ?? {};
  if (typeof challengeId !== "string") {
    return res.status(400).json({ error: "invalid_request", message: "challengeId is required" });
  }
  const result = requestAssistedToken(challengeId, sourceFromRequest(req));
  if (!result.ok) return res.status(result.error === "wait" ? 429 : 400).json(result);
  return res.json(result);
});
