import { Router } from "express";
import { prisma } from "../services/db.js";
import { requireAdmin } from "../middleware/auth.js";
import crypto from "crypto";

const router = Router();

function generateApiKey() {
  return "rm_" + crypto.randomBytes(32).toString("hex");
}

router.post("/", requireAdmin, async (req, res) => {
  const { name, scopes } = req.body;
  if (!name || !Array.isArray(scopes)) {
    res.status(400).json({ error: "invalid_request", message: "name and scopes (array) are required" });
    return;
  }

  try {
    const key = generateApiKey();
    const apiKey = await prisma.apiKey.create({
      data: {
        name,
        key,
        scopes,
      },
    });

    res.status(201).json({ message: "API key created", apiKey });
  } catch (err) {
    res.status(500).json({ error: "internal_server_error", message: "Error creating API key" });
  }
});

router.post("/:id/revoke", requireAdmin, async (req, res) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;

  try {
    const apiKey = await prisma.apiKey.update({
      where: { id },
      data: { revoked: true },
    });

    res.json({ message: "API key revoked", apiKey });
  } catch (err) {
    res.status(500).json({ error: "internal_server_error", message: "Error revoking API key" });
  }
});

export const apiKeysRouter = router;
