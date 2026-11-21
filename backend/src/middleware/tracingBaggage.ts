// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import type { Context } from "@opentelemetry/api";
import { context, propagation } from "@opentelemetry/api";
import type { RequestHandler } from "express";
import { getCurrentTenant } from "../services/tenant.js";

/**
 * OpenTelemetry baggage keys carrying the request's identity:
 *   - `enduser.id`  — the authenticated user (wallet address).
 *   - `tenant.id`   — the resolved white-label tenant.
 *
 * `enduser.id` follows the OpenTelemetry semantic convention for the end user;
 * both keys are plain W3C baggage entries so a trace can be filtered by user or
 * tenant across every service that participates in the trace.
 */
export const BAGGAGE_USER_ID_KEY = "enduser.id";
export const BAGGAGE_TENANT_ID_KEY = "tenant.id";

interface IdentityRequest {
  user?: { walletAddress?: string };
}

/**
 * Merge `entries` into the baggage of the currently active context, preserving
 * any baggage already there (e.g. propagated from an upstream service), and
 * return the resulting context.
 */
function contextWithBaggage(entries: Record<string, string | undefined>): Context {
  let bag = propagation.getActiveBaggage() ?? propagation.createBaggage();

  for (const [key, value] of Object.entries(entries)) {
    if (value) bag = bag.setEntry(key, { value });
  }

  return propagation.setBaggage(context.active(), bag);
}

/**
 * Attach the tenant — and the user id when it is already known — to the tracing
 * baggage for the lifetime of the request, so every span and every downstream
 * hop can be correlated by user or tenant.
 *
 * The tenant is resolved before this runs (`tenantContext`), but the user id is
 * only established once authentication has run further down the chain, so
 * authenticated routes add it through {@link runWithUserBaggage}.
 *
 * Baggage rides the existing trace-propagation channel only: it is exported to
 * the OTLP collector exactly like trace context and is never written to logs or
 * any other, less restricted, output.
 */
export const tracingBaggageMiddleware: RequestHandler = (req, _res, next) => {
  const entries: Record<string, string | undefined> = {
    [BAGGAGE_TENANT_ID_KEY]: getCurrentTenant().id,
    [BAGGAGE_USER_ID_KEY]: (req as IdentityRequest).user?.walletAddress,
  };

  context.with(contextWithBaggage(entries), () => next());
};

/**
 * Run `fn` (typically Express's `next`) with the authenticated user's id merged
 * into the active baggage, keeping any baggage already set for the request.
 * A no-op wrapper when no user id is available (anonymous requests).
 */
export function runWithUserBaggage(userId: string | undefined, fn: () => void): void {
  if (!userId) {
    fn();
    return;
  }
  context.with(contextWithBaggage({ [BAGGAGE_USER_ID_KEY]: userId }), fn);
}
