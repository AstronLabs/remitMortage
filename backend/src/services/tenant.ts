// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Multi-tenant white-label branding (issue #697).
 *
 * Tenants are configured through `TENANT_BRANDING`, a JSON array of records:
 *
 *   [{ "id": "acme", "name": "Acme Homes", "legalEntity": "Acme Lending LLC",
 *      "hosts": ["loans.acme.com"], "logoUrl": "https://cdn.acme.com/logo.png",
 *      "colors": { "header": "#112233", "primary": "#ff6600" },
 *      "senderDomain": "acme.com", "supportEmail": "help@acme.com" }]
 *
 * Each request resolves its tenant from the `X-Tenant-Id` header or the Host
 * header and runs inside an AsyncLocalStorage context, so concurrent requests
 * for different tenants never share branding. Anything outside a request
 * (jobs, workers without a tenant) gets the default tenant.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, RequestHandler } from "express";
import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";

export interface TenantBranding {
  id: string;
  /** Product name shown in email headers and subjects. */
  name: string;
  /** Legal entity shown in the email header and copyright footer. */
  legalEntity: string;
  logoUrl: string | null;
  colors: { header: string; primary: string };
  /** Domain outbound email is sent from. */
  senderDomain: string;
  /** From address for outbound email. Defaults to no-reply@senderDomain. */
  senderEmail: string;
  supportEmail: string | null;
  /** Hostnames (without port) that resolve to this tenant. */
  hosts: string[];
}

export const TENANT_HEADER = "X-Tenant-Id";
export const DEFAULT_TENANT_ID = "default";

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const TENANT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+$/;

function defaultTenant(): TenantBranding {
  const config = loadConfig();
  const senderEmail = config.smtpFrom || "no-reply@remitmortgage.com";
  return {
    id: DEFAULT_TENANT_ID,
    name: "RemitMortgage",
    legalEntity: "AstronLabs",
    logoUrl: null,
    colors: { header: "#0f172a", primary: "#3b82f6" },
    senderDomain: senderEmail.split("@")[1] ?? "remitmortgage.com",
    senderEmail,
    supportEmail: null,
    hosts: [],
  };
}

/** Validates one configured record. Returns null (and logs) when it is unusable. */
export function parseTenant(raw: unknown): TenantBranding | null {
  const r = (raw ?? {}) as Record<string, any>;
  const problems: string[] = [];

  if (typeof r.id !== "string" || !TENANT_ID.test(r.id) || r.id === DEFAULT_TENANT_ID) {
    problems.push("id");
  }
  if (typeof r.name !== "string" || !r.name.trim()) problems.push("name");
  if (typeof r.legalEntity !== "string" || !r.legalEntity.trim()) problems.push("legalEntity");
  if (typeof r.senderDomain !== "string" || !DOMAIN.test(r.senderDomain)) problems.push("senderDomain");
  if (r.logoUrl != null && (typeof r.logoUrl !== "string" || !r.logoUrl.startsWith("https://"))) {
    problems.push("logoUrl");
  }
  if (!HEX_COLOR.test(r.colors?.header ?? "") || !HEX_COLOR.test(r.colors?.primary ?? "")) {
    problems.push("colors");
  }
  const senderEmail = r.senderEmail ?? `no-reply@${r.senderDomain}`;
  if (
    typeof senderEmail !== "string" ||
    !EMAIL.test(senderEmail) ||
    !senderEmail.toLowerCase().endsWith(`@${String(r.senderDomain).toLowerCase()}`)
  ) {
    problems.push("senderEmail");
  }
  if (r.supportEmail != null && (typeof r.supportEmail !== "string" || !EMAIL.test(r.supportEmail))) {
    problems.push("supportEmail");
  }
  if (!Array.isArray(r.hosts) || r.hosts.some((h: unknown) => typeof h !== "string" || !DOMAIN.test(h))) {
    problems.push("hosts");
  }

  if (problems.length > 0) {
    logger.error("[tenant] ignoring invalid tenant config", { id: r.id, invalid: problems });
    return null;
  }

  return {
    id: r.id,
    name: r.name.trim(),
    legalEntity: r.legalEntity.trim(),
    logoUrl: r.logoUrl ?? null,
    colors: { header: r.colors.header, primary: r.colors.primary },
    senderDomain: r.senderDomain.toLowerCase(),
    senderEmail,
    supportEmail: r.supportEmail ?? null,
    hosts: r.hosts.map((h: string) => h.toLowerCase()),
  };
}

interface Registry {
  fallback: TenantBranding;
  byId: Map<string, TenantBranding>;
  byHost: Map<string, TenantBranding>;
}

let cached: { key: string; registry: Registry } | null = null;

function registry(): Registry {
  const config = loadConfig();
  const key = JSON.stringify([config.tenantBranding ?? [], config.smtpFrom]);
  if (cached?.key === key) return cached.registry;

  const fallback = defaultTenant();
  const byId = new Map<string, TenantBranding>([[fallback.id, fallback]]);
  const byHost = new Map<string, TenantBranding>();

  for (const raw of config.tenantBranding ?? []) {
    const tenant = parseTenant(raw);
    if (!tenant) continue;
    if (byId.has(tenant.id) || tenant.hosts.some((h) => byHost.has(h))) {
      logger.error("[tenant] ignoring tenant with duplicate id or host", { id: tenant.id });
      continue;
    }
    byId.set(tenant.id, tenant);
    for (const host of tenant.hosts) byHost.set(host, tenant);
  }

  cached = { key, registry: { fallback, byId, byHost } };
  return cached.registry;
}

export function getDefaultTenant(): TenantBranding {
  return registry().fallback;
}

export function getTenantById(id: string): TenantBranding | undefined {
  return registry().byId.get(id);
}

/**
 * Picks the tenant for a request: a known `X-Tenant-Id` wins, then the Host
 * header, then the default tenant. Unknown values fall through.
 */
export function resolveTenant(req: Pick<Request, "hostname" | "headers">): TenantBranding {
  const { fallback, byId, byHost } = registry();
  const header = req.headers[TENANT_HEADER.toLowerCase()];
  if (typeof header === "string" && byId.has(header)) return byId.get(header)!;

  const host = req.hostname?.toLowerCase();
  return (host && byHost.get(host)) || fallback;
}

const tenantStorage = new AsyncLocalStorage<TenantBranding>();

/** Tenant of the in-flight request, or the default tenant outside one. */
export function getCurrentTenant(): TenantBranding {
  return tenantStorage.getStore() ?? getDefaultTenant();
}

/** Runs `fn` with the given tenant (by id) as the current tenant. Unknown ids use the default. */
export function runWithTenant<T>(tenantId: string | undefined, fn: () => T): T {
  const tenant = (tenantId && getTenantById(tenantId)) || getDefaultTenant();
  return tenantStorage.run(tenant, fn);
}

/** Resolves the tenant once per request and scopes the rest of the chain to it. */
export const tenantContext: RequestHandler = (req, _res, next) => {
  tenantStorage.run(resolveTenant(req), () => next());
};
