import { Router } from "express";
import { prisma } from "../services/db.js";
import { authMiddleware, AuthenticatedRequest } from "../middleware/auth.js";
import { requireWorkspaceAccess } from "../middleware/workspaceAccess.js";

export const workspaceRouter = Router();

function normalizeSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "workspace";
}

function canAccessWorkspace(role: string | null | undefined): boolean {
  return role === "OWNER" || role === "BUILDER" || role === "VIEWER";
}

function normalizeRole(role: unknown): "OWNER" | "BUILDER" | "VIEWER" {
  if (role === "OWNER" || role === "BUILDER" || role === "VIEWER") {
    return role;
  }

  return "BUILDER";
}

workspaceRouter.use(authMiddleware);

workspaceRouter.post("/", async (req: AuthenticatedRequest, res) => {
  try {
    const { name, slug } = req.body ?? {};

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "missing_field", field: "name", message: "name is required" });
    }

    const resolvedSlug = normalizeSlug(typeof slug === "string" && slug.trim() ? slug : name);

    const workspace = await prisma.workspace.create({
      data: {
        name,
        slug: resolvedSlug,
        createdBy: req.user?.walletAddress ?? "",
        members: {
          create: {
            walletAddress: req.user?.walletAddress ?? "",
            role: "OWNER",
          },
        },
      },
    });

    return res.status(201).json({ workspace });
  } catch (error: any) {
    if (error?.code === "P2002") {
      return res.status(409).json({ error: "workspace_exists", message: "A workspace with that slug already exists" });
    }

    return res.status(500).json({ error: "workspace_create_failed", message: "Unable to create workspace" });
  }
});

workspaceRouter.post("/:workspaceId/invitations", requireWorkspaceAccess, async (req: AuthenticatedRequest, res) => {
  try {
    const rawWorkspaceId = req.params.workspaceId;
    const workspaceId = Array.isArray(rawWorkspaceId) ? rawWorkspaceId[0] : rawWorkspaceId;
    const { inviteeAddress, role } = req.body ?? {};

    if (!inviteeAddress || typeof inviteeAddress !== "string") {
      return res.status(400).json({ error: "missing_field", field: "inviteeAddress", message: "inviteeAddress is required" });
    }

    if (!req.user?.walletAddress) {
      return res.status(401).json({ error: "unauthorized", message: "Authentication token missing" });
    }

    const membership = await prisma.workspaceMember.findFirst({
      where: {
        workspaceId,
        walletAddress: req.user.walletAddress,
      },
    });

    if (!membership || !["OWNER", "BUILDER"].includes(membership.role)) {
      return res.status(403).json({ error: "forbidden", message: "Only owners or builders can invite collaborators" });
    }

    const normalizedRole = normalizeRole(role);

    const invitation = await prisma.workspaceInvitation.create({
      data: {
        workspaceId,
        inviteeAddress,
        invitedBy: req.user.walletAddress,
        role: normalizedRole,
      },
    });

    return res.status(201).json({ invitation });
  } catch (error: any) {
    if (error?.code === "P2025") {
      return res.status(404).json({ error: "workspace_not_found", message: "Workspace not found" });
    }

    return res.status(500).json({ error: "invitation_create_failed", message: "Unable to create invitation" });
  }
});

workspaceRouter.get("/:workspaceId/dashboard", requireWorkspaceAccess, async (req: AuthenticatedRequest, res) => {
  try {
    const rawWorkspaceId = req.params.workspaceId;
    const workspaceId = Array.isArray(rawWorkspaceId) ? rawWorkspaceId[0] : rawWorkspaceId;
    const walletAddress = req.user?.walletAddress;

    if (!walletAddress) {
      return res.status(401).json({ error: "unauthorized", message: "Authentication token missing" });
    }

    const membership = await prisma.workspaceMember.findFirst({
      where: {
        workspaceId,
        walletAddress,
      },
    });

    if (!membership || !canAccessWorkspace(membership.role)) {
      return res.status(403).json({ error: "forbidden", message: "You do not have access to this workspace" });
    }

    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, include: { members: true, invitations: true } });

    if (!workspace) {
      return res.status(404).json({ error: "workspace_not_found", message: "Workspace not found" });
    }

    const w = workspace as any;
    return res.json({ workspace: w, accessRole: membership.role, dashboard: { memberCount: w.members.length, pendingInvites: w.invitations.filter((invitation: any) => invitation.status === "PENDING").length } });
  } catch (error) {
    return res.status(500).json({ error: "workspace_dashboard_failed", message: "Unable to load workspace dashboard" });
  }
});
