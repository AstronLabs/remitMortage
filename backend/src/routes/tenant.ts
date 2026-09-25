// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router } from "express";
import { getCurrentTenant } from "../services/tenant.js";

export const tenantRouter = Router();

/**
 * @openapi
 * /api/tenant/branding:
 *   get:
 *     summary: Branding for the tenant this request resolved to
 *     description: >-
 *       Resolved from the X-Tenant-Id header or the Host header. Returns only
 *       display fields; sender configuration and host mappings stay private.
 *     tags:
 *       - Tenant
 *     responses:
 *       200:
 *         description: Tenant branding.
 */
tenantRouter.get("/branding", (_req, res) => {
  const { id, name, legalEntity, logoUrl, colors, supportEmail } = getCurrentTenant();
  res.json({ id, name, legalEntity, logoUrl, colors, supportEmail });
});
