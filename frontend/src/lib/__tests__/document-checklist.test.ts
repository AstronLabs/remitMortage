// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  buildDocumentChecklist,
  canSubmitApplication,
  getChecklistItemAction,
  getChecklistStatus,
  getSubmissionBlockMessage,
  getUnacceptedRequiredDocuments,
  normalizeDocumentStatus,
  toChecklistItemState,
  type ApplicantDocument,
  type DocumentChecklistStatus,
  type RequiredDocumentType,
} from "../document-checklist";

const allAccepted: ApplicantDocument[] = [
  { documentId: "id-1", documentType: "identity", status: "accepted", originalName: "id.pdf", uploadedAt: "2026-01-01T00:00:00.000Z" },
  { documentId: "inc-1", documentType: "income", status: "accepted", originalName: "income.pdf", uploadedAt: "2026-01-01T00:00:00.000Z" },
  { documentId: "bank-1", documentType: "bank_statement", status: "accepted", originalName: "bank.pdf", uploadedAt: "2026-01-01T00:00:00.000Z" },
  { documentId: "property-1", documentType: "property_contract", status: "accepted", originalName: "sale.pdf", uploadedAt: "2026-01-01T00:00:00.000Z" },
];

function documentWithStatus(status: ApplicantDocument["status"]): ApplicantDocument {
  return {
    documentId: `identity-${status}`,
    documentType: "identity",
    status,
    originalName: "identity.pdf",
    uploadedAt: "2026-02-01T00:00:00.000Z",
  };
}

describe("loan document checklist status and submission rules", () => {
  it.each([
    [undefined, "missing"],
    ["Uploaded", "uploaded"],
    ["Under Review", "under_review"],
    ["Accepted", "accepted"],
    ["Rejected", "rejected"],
  ] as const)("normalizes the %s status to %s", (apiStatus, expected) => {
    expect(normalizeDocumentStatus(apiStatus)).toBe(expected);
  });

  it.each(["missing", "uploaded", "under_review", "rejected"] as const)(
    "does not allow %s documents to satisfy a required item",
    (status) => {
      const documents = [...allAccepted, documentWithStatus(status)];
      expect(getChecklistStatus("identity", documents)).toBe(status);
      expect(canSubmitApplication("purchase", documents)).toBe(false);
      expect(getSubmissionBlockMessage("purchase", documents)).toMatch(/accepted/);
    }
  );

  it("allows submission only when every required purchase document is accepted", () => {
    expect(canSubmitApplication("purchase", allAccepted)).toBe(true);
    expect(getUnacceptedRequiredDocuments("purchase", allAccepted)).toHaveLength(0);
    expect(getSubmissionBlockMessage("purchase", allAccepted)).toBeNull();
  });

  it("uses construction-plan requirements for construction loans", () => {
    expect(canSubmitApplication("construction", allAccepted)).toBe(false);
    const constructionAccepted = [
      ...allAccepted.filter((document) => document.documentType !== "property_contract"),
      { documentId: "plan-1", documentType: "construction_plan" as const, status: "accepted" as const, originalName: "plan.pdf", uploadedAt: "2026-01-01T00:00:00.000Z" },
    ];
    expect(canSubmitApplication("construction", constructionAccepted)).toBe(true);
  });

  it("uses the newest upload status for a document type", () => {
    const documents = [
      documentWithStatus("accepted"),
      { ...documentWithStatus("rejected"), documentId: "newer", uploadedAt: "2026-03-01T00:00:00.000Z" },
    ];
    expect(getChecklistStatus("identity", documents)).toBe("rejected");
  });
});

describe("buildDocumentChecklist (issue #1112)", () => {
  const doc = (
    documentType: RequiredDocumentType,
    status: DocumentChecklistStatus,
    uploadedAt: string,
    reviewMessage?: string
  ): ApplicantDocument => ({
    documentId: `${documentType}-${uploadedAt}`,
    documentType,
    status,
    originalName: `${documentType}.pdf`,
    uploadedAt,
    ...(reviewMessage ? { reviewMessage } : {}),
  });

  it("maps every API status to one of the four checklist states", () => {
    expect(toChecklistItemState("missing")).toBe("not_submitted");
    expect(toChecklistItemState("uploaded")).toBe("pending_review");
    expect(toChecklistItemState("under_review")).toBe("pending_review");
    expect(toChecklistItemState("accepted")).toBe("approved");
    expect(toChecklistItemState("rejected")).toBe("rejected");
  });

  it("offers resubmission only for rejected items", () => {
    expect(getChecklistItemAction("rejected")).toBe("resubmit");
    expect(getChecklistItemAction("not_submitted")).toBe("upload");
    expect(getChecklistItemAction("pending_review")).toBeNull();
    expect(getChecklistItemAction("approved")).toBeNull();
  });

  it("lists every required document for the loan type with its latest state", () => {
    const items = buildDocumentChecklist("construction", [
      doc("identity", "rejected", "2026-01-01T00:00:00.000Z", "Blurry scan"),
      doc("identity", "under_review", "2026-01-02T00:00:00.000Z"),
      doc("income", "rejected", "2026-01-03T00:00:00.000Z", "Expired payslip"),
      doc("construction_plan", "accepted", "2026-01-04T00:00:00.000Z"),
    ]);

    expect(items.map((item) => item.type)).toEqual([
      "identity",
      "income",
      "bank_statement",
      "construction_plan",
    ]);
    expect(items.map((item) => [item.state, item.action])).toEqual([
      ["pending_review", null],
      ["rejected", "resubmit"],
      ["not_submitted", "upload"],
      ["approved", null],
    ]);
    expect(items[1].rejectionReason).toBe("Expired payslip");
    expect(items[0].rejectionReason).toBeUndefined();
  });

  it("falls back to a generic reason when a rejection has none", () => {
    const [identity] = buildDocumentChecklist("purchase", [
      doc("identity", "rejected", "2026-01-01T00:00:00.000Z"),
    ]);
    expect(identity.rejectionReason).toBe("No reason was provided by the reviewer.");
  });
});
