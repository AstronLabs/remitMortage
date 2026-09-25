// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { NextFunction, Response } from "express";
import { prisma } from "../services/db.js";
import { AuthenticatedRequest } from "./auth.js";

export async function requireWorkspaceAccess(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  const rawWorkspaceId = req.params.workspaceId || req.params.id;
  const workspaceId = Array.isArray(rawWorkspaceId) ? rawWorkspaceId[0] : rawWorkspaceId;
  const walletAddress = req.user?.walletAddress;

  if (!walletAddress) {
    res.status(401).json({ error: "unauthorized", message: "Authentication token missing" });
    return;
  }

  if (!workspaceId) {
    res.status(400).json({ error: "missing_field", field: "workspaceId", message: "workspaceId is required" });
    return;
  }

  try {
    const membership = await prisma.workspaceMember.findFirst({
      where: {
        workspaceId,
        walletAddress,
      },
    });

    if (!membership) {
      res.status(403).json({ error: "forbidden", message: "You do not have access to this workspace" });
      return;
    }

    req.workspaceAccess = {
      workspaceId,
      role: membership.role,
    };

    next();
  } catch (error) {
    res.status(500).json({ error: "workspace_access_check_failed", message: "Unable to validate workspace access" });
  }
}
