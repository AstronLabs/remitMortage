// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

export type LoanType = "purchase" | "construction";
export type DocumentChecklistStatus =
  | "missing"
  | "uploaded"
  | "under_review"
  | "accepted"
  | "rejected";

export type RequiredDocumentType =
  | "identity"
  | "income"
  | "bank_statement"
  | "property_contract"
  | "construction_plan";

export interface RequiredDocument {
  type: RequiredDocumentType;
  label: string;
}

export interface ApplicantDocument {
  documentId: string;
  documentType: RequiredDocumentType;
  status: DocumentChecklistStatus;
  originalName: string;
  uploadedAt: string;
  reviewMessage?: string;
}

export const REQUIRED_DOCUMENTS: Record<LoanType, RequiredDocument[]> = {
  purchase: [
    { type: "identity", label: "Government-issued identity document" },
    { type: "income", label: "Proof of income" },
    { type: "bank_statement", label: "Recent bank statement" },
    { type: "property_contract", label: "Property purchase agreement" },
  ],
  construction: [
    { type: "identity", label: "Government-issued identity document" },
    { type: "income", label: "Proof of income" },
    { type: "bank_statement", label: "Recent bank statement" },
    { type: "construction_plan", label: "Approved construction plan" },
  ],
};

const API_STATUS_TO_CHECKLIST: Record<string, DocumentChecklistStatus> = {
  Uploaded: "uploaded",
  "Under Review": "under_review",
  Accepted: "accepted",
  Rejected: "rejected",
};

export function normalizeDocumentStatus(status: string | undefined): DocumentChecklistStatus {
  return (status && API_STATUS_TO_CHECKLIST[status]) || "missing";
}

/** Most recent submission for a type determines its current checklist state. */
export function getChecklistStatus(
  documentType: RequiredDocumentType,
  documents: ApplicantDocument[]
): DocumentChecklistStatus {
  const latest = documents
    .filter((document) => document.documentType === documentType)
    .sort((left, right) => Date.parse(right.uploadedAt) - Date.parse(left.uploadedAt))[0];
  return latest?.status ?? "missing";
}

export function getLatestDocument(
  documentType: RequiredDocumentType,
  documents: ApplicantDocument[]
): ApplicantDocument | undefined {
  return documents
    .filter((document) => document.documentType === documentType)
    .sort((left, right) => Date.parse(right.uploadedAt) - Date.parse(left.uploadedAt))[0];
}

export function getUnacceptedRequiredDocuments(
  loanType: LoanType,
  documents: ApplicantDocument[]
): RequiredDocument[] {
  return REQUIRED_DOCUMENTS[loanType].filter(
    (required) => getChecklistStatus(required.type, documents) !== "accepted"
  );
}

export function canSubmitApplication(loanType: LoanType, documents: ApplicantDocument[]): boolean {
  return getUnacceptedRequiredDocuments(loanType, documents).length === 0;
}

export function getSubmissionBlockMessage(
  loanType: LoanType,
  documents: ApplicantDocument[]
): string | null {
  const outstanding = getUnacceptedRequiredDocuments(loanType, documents);
  if (outstanding.length === 0) return null;
  const names = outstanding.map((document) => document.label).join(", ");
  return `Submission is unavailable until all required documents are accepted. Still needed: ${names}.`;
}
/**
 * Applicant-facing checklist state (issue #1112). "Uploaded" and "Under
 * review" both mean the applicant is waiting on a reviewer, so they collapse
 * into a single pending-review state.
 */
export type ChecklistItemState = "not_submitted" | "pending_review" | "approved" | "rejected";

/** The action an applicant can take on a checklist item, if any. */
export type ChecklistItemAction = "upload" | "resubmit" | null;

export function toChecklistItemState(status: DocumentChecklistStatus): ChecklistItemState {
  switch (status) {
    case "accepted":
      return "approved";
    case "rejected":
      return "rejected";
    case "uploaded":
    case "under_review":
      return "pending_review";
    default:
      return "not_submitted";
  }
}

/**
 * Only an item that was never submitted can be uploaded, and only a rejected
 * item can be resubmitted. Pending and approved items offer no action.
 */
export function getChecklistItemAction(state: ChecklistItemState): ChecklistItemAction {
  if (state === "not_submitted") return "upload";
  if (state === "rejected") return "resubmit";
  return null;
}

export interface ChecklistItem {
  type: RequiredDocumentType;
  label: string;
  state: ChecklistItemState;
  action: ChecklistItemAction;
  /** Latest submission for this type, if any. */
  document?: ApplicantDocument;
  /** Reviewer's reason, present only for rejected items. */
  rejectionReason?: string;
}

/** Every document the loan type requires, with its current state and action. */
export function buildDocumentChecklist(
  loanType: LoanType,
  documents: ApplicantDocument[]
): ChecklistItem[] {
  return REQUIRED_DOCUMENTS[loanType].map((required) => {
    const document = getLatestDocument(required.type, documents);
    const state = toChecklistItemState(document?.status ?? "missing");
    return {
      type: required.type,
      label: required.label,
      state,
      action: getChecklistItemAction(state),
      ...(document ? { document } : {}),
      ...(state === "rejected"
        ? { rejectionReason: document?.reviewMessage?.trim() || "No reason was provided by the reviewer." }
        : {}),
    };
  });
}
