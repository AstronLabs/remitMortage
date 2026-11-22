// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Sanctions-list screening provider (issue #922).
 *
 * Interface + Null default + Http implementation + settable singleton,
 * mirroring `payrollVerificationProvider.ts`. The provider answers one
 * question per party — does this subject match an entry on a sanctions list —
 * and reports which version of the lists it checked against, so the pool can
 * tell when the lists have moved and everyone needs re-screening.
 */

import axios from "axios";
import logger from "../utils/logger.js";

export type SanctionsPartyType = "APPLICANT" | "CONTRACTOR" | "INVESTOR";

export const SANCTIONS_PARTY_TYPES: readonly SanctionsPartyType[] = [
  "APPLICANT",
  "CONTRACTOR",
  "INVESTOR",
];

export type SanctionsOutcome = "clear" | "potential_match" | "confirmed_match";

export interface SanctionsMatch {
  /** The provider's identifier for the list entry that matched. */
  entryId: string;
  listName: string | null;
  /** Match strength, 0-100, when the provider reports one. */
  score: number | null;
}

export interface SanctionsScreeningRequest {
  partyType: SanctionsPartyType;
  /** Stellar address of the party; the stable reference sent to the provider. */
  address: string;
  name?: string | null;
  country?: string | null;
}

export interface SanctionsScreeningResult {
  outcome: SanctionsOutcome;
  matches: SanctionsMatch[];
  /** Version of the sanctions lists this result was computed against. */
  listVersion: string | null;
  providerReference: string | null;
  providerName: string | null;
}

export interface SanctionsProvider {
  screen(request: SanctionsScreeningRequest): Promise<SanctionsScreeningResult>;
  /** Current version of the lists, or null when the provider cannot say. */
  getListVersion(): Promise<string | null>;
}

/**
 * Default when no provider is configured. It refuses to answer: an
 * unconfigured provider must never read as "everyone is clear".
 */
export class NullSanctionsProvider implements SanctionsProvider {
  async screen(): Promise<SanctionsScreeningResult> {
    throw new Error("no sanctions screening provider is configured");
  }

  async getListVersion(): Promise<string | null> {
    return null;
  }
}

export interface HttpSanctionsProviderOptions {
  /** Base URL; `POST {url}/screen` and `GET {url}/list-version` are called. */
  url: string;
  apiKey?: string | null;
  providerName?: string;
  timeoutMs?: number;
}

const OUTCOMES: readonly SanctionsOutcome[] = ["clear", "potential_match", "confirmed_match"];

export class HttpSanctionsProvider implements SanctionsProvider {
  constructor(private readonly options: HttpSanctionsProviderOptions) {}

  private headers() {
    return this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {};
  }

  async screen(request: SanctionsScreeningRequest): Promise<SanctionsScreeningResult> {
    const response = await axios.post(
      `${this.options.url.replace(/\/+$/, "")}/screen`,
      {
        reference: request.address,
        entityType: request.partyType.toLowerCase(),
        name: request.name ?? null,
        country: request.country ?? null,
      },
      { timeout: this.options.timeoutMs ?? 10_000, headers: this.headers() }
    );

    const body = response.data ?? {};
    // An outcome the pool does not recognise is an error, never a clear.
    if (!OUTCOMES.includes(body.outcome)) {
      throw new Error(`sanctions provider returned an unknown outcome: ${String(body.outcome)}`);
    }
    const matches: SanctionsMatch[] = Array.isArray(body.matches)
      ? body.matches.map((m: any) => ({
          entryId: String(m.entryId ?? m.id ?? ""),
          listName: m.listName ?? null,
          score: typeof m.score === "number" ? m.score : null,
        }))
      : [];
    return {
      outcome: body.outcome,
      matches,
      listVersion: body.listVersion != null ? String(body.listVersion) : null,
      providerReference: body.referenceId ?? null,
      providerName: this.options.providerName ?? null,
    };
  }

  async getListVersion(): Promise<string | null> {
    const response = await axios.get(`${this.options.url.replace(/\/+$/, "")}/list-version`, {
      timeout: this.options.timeoutMs ?? 10_000,
      headers: this.headers(),
    });
    const version = response.data?.version;
    return version != null ? String(version) : null;
  }
}

let activeProvider: SanctionsProvider = new NullSanctionsProvider();

export function setSanctionsProvider(provider: SanctionsProvider): void {
  activeProvider = provider;
}

export function getSanctionsProvider(): SanctionsProvider {
  return activeProvider;
}

export type SanctionsProviderCall =
  | { ok: true; result: SanctionsScreeningResult }
  | { ok: false; error: string };

/**
 * Runs the active provider and never throws. An outage, timeout or malformed
 * answer comes back as `{ ok: false }`, so callers can tell "the provider
 * could not say" apart from "the provider said clear".
 */
export async function requestSanctionsScreening(
  request: SanctionsScreeningRequest
): Promise<SanctionsProviderCall> {
  try {
    return { ok: true, result: await activeProvider.screen(request) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("[sanctions] Provider screening call failed", { error: message });
    return { ok: false, error: message };
  }
}

/** The provider's current list version, or null if it cannot be determined. */
export async function fetchSanctionsListVersion(): Promise<string | null> {
  try {
    return await activeProvider.getListVersion();
  } catch (err) {
    logger.warn("[sanctions] Provider list-version call failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
