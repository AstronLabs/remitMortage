import { Request, Response, NextFunction } from "express";
import { prisma } from "../services/db.js";

export function requireScopedApiKey(requiredScope: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing_authorization", message: "Authorization header is required" });
      return;
    }

    const token = authHeader.slice(7);

    try {
      const apiKey = await prisma.apiKey.findUnique({
        where: { key: token },
      });

      if (!apiKey || apiKey.revoked) {
        res.status(403).json({ error: "forbidden", message: "Invalid or revoked API key" });
        return;
      }

      // Allow if the key has the required scope or a wildcard scope.
      // E.g. scope checking could be a prefix match or exact match. We'll use exact match or wildcard '*'.
      const hasScope = apiKey.scopes.includes(requiredScope) || apiKey.scopes.includes("*");
      
      if (!hasScope) {
        res.status(403).json({ error: "forbidden", message: "API key lacks required scope for this endpoint" });
        return;
      }

      next();
    } catch (err) {
      res.status(500).json({ error: "internal_server_error", message: "Error validating API key" });
    }
  };
}
