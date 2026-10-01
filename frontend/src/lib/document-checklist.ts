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