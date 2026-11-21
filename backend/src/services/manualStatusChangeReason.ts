// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Reason codes required on every manual applicant status change (issue #1102).
 *
 * An operator moving an application's status by hand — rejecting it, recording
 * a manual review decision, or deciding a batch — must pick one of these codes
 * (plus an optional free-text note) so the application's history explains the
 * change to whoever reviews it later. Automated workflow transitions (the
 * Approved → Disbursing hop, auto-rejection rules, stale-draft cleanup) never
 * go through this module: they already carry their own system context.
 */

export const MANUAL_STATUS_CHANGE_REASON_CODES = {
  DOCUMENTATION_VERIFIED: "Documentation verified",
  DOCUMENTATION_INCOMPLETE: "Documentation incomplete",
  ELIGIBILITY_NOT_MET: "Eligibility criteria not met",
  DUPLICATE_APPLICATION: "Duplicate application",
  SUSPECTED_FRAUD: "Suspected fraud",
  APPLICANT_REQUEST: "Requested by applicant",
  REVIEWER_REASSIGNMENT: "Reassigned to another reviewer",
  DATA_CORRECTION: "Correcting a data error",
  POLICY_EXCEPTION: "Approved policy exception",
  OTHER: "Other",
} as const;

export type ManualStatusChangeReasonCode = keyof typeof MANUAL_STATUS_CHANGE_REASON_CODES;

/** Upper bound on the free-text note so the audit row stays reasonably sized. */
export const MAX_REASON_NOTE_LENGTH = 1000;

/** The reason stored alongside a manual status change in the activity history. */
export interface ManualStatusChangeReason {
  code: ManualStatusChangeReasonCode;
  label: string;
  note?: string;
}

export type ParseReasonResult =
  | { ok: true; reason: ManualStatusChangeReason }
  | { ok: false; error: "missing_reason_code" | "invalid_reason_code" | "invalid_reason_note"; message: string };

export function isManualStatusChangeReasonCode(value: unknown): value is ManualStatusChangeReasonCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(MANUAL_STATUS_CHANGE_REASON_CODES, value);
}

/**
 * Validates the `reasonCode` / `reasonNote` pair sent with a manual status
 * change. The code must come from the fixed list; the note is optional except
 * for `OTHER`, where the code alone says nothing about why.
 */
export function parseManualStatusChangeReason(reasonCode: unknown, reasonNote?: unknown): ParseReasonResult {
  if (reasonCode === undefined || reasonCode === null || reasonCode === "") {
    return {
      ok: false,
      error: "missing_reason_code",
      message: `reasonCode is required for a manual status change. One of: ${Object.keys(MANUAL_STATUS_CHANGE_REASON_CODES).join(", ")}`,
    };
  }
  if (!isManualStatusChangeReasonCode(reasonCode)) {
    return {
      ok: false,
      error: "invalid_reason_code",
      message: `reasonCode must be one of: ${Object.keys(MANUAL_STATUS_CHANGE_REASON_CODES).join(", ")}`,
    };
  }
  if (reasonNote !== undefined && reasonNote !== null && typeof reasonNote !== "string") {
    return { ok: false, error: "invalid_reason_note", message: "reasonNote must be a string" };
  }
  const note = typeof reasonNote === "string" ? reasonNote.trim() : "";
  if (note.length > MAX_REASON_NOTE_LENGTH) {
    return {
      ok: false,
      error: "invalid_reason_note",
      message: `reasonNote must be at most ${MAX_REASON_NOTE_LENGTH} characters`,
    };
  }
  if (reasonCode === "OTHER" && note.length === 0) {
    return { ok: false, error: "invalid_reason_note", message: "reasonNote is required when reasonCode is OTHER" };
  }

  return {
    ok: true,
    reason: {
      code: reasonCode,
      label: MANUAL_STATUS_CHANGE_REASON_CODES[reasonCode],
      ...(note ? { note } : {}),
    },
  };
}

/** Human-readable form of a reason, e.g. "Duplicate application: same tax id". */
export function describeManualStatusChangeReason(reason: ManualStatusChangeReason): string {
  return reason.note ? `${reason.label}: ${reason.note}` : reason.label;
}
