// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import DocumentChecklist from "../DocumentChecklist";

const allAccepted = [
  "identity",
  "income",
  "bank_statement",
  "property_contract",
].map((documentType, index) => ({
  documentId: `document-${index}`,
  applicantAddress: "GApplicant",
  documentType,
  status: "Accepted",
  originalName: `${documentType}.pdf`,
  uploadedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
}));

describe("DocumentChecklist", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it("shows initial missing items and enables eligibility after a live status update", async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => allAccepted });
    global.fetch = fetchMock as jest.Mock;
    const onEligibilityChange = jest.fn();

    render(
      <DocumentChecklist
        applicantAddress="GApplicant"
        loanType="purchase"
        pollIntervalMs={1000}
        onEligibilityChange={onEligibilityChange}
      />
    );

    expect(await screen.findAllByText("Not submitted", { selector: "span" })).toHaveLength(4);
    expect(screen.getByText(/Submission is unavailable until all required documents are accepted/)).toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(onEligibilityChange).toHaveBeenLastCalledWith(true));
    expect(screen.getAllByText("Approved", { selector: "span" })).toHaveLength(4);
    expect(screen.queryByText(/Submission is unavailable/)).not.toBeInTheDocument();
  });

  it("uploads the selected document type and refreshes status", async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ documentId: "new-id" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });
    global.fetch = fetchMock as jest.Mock;
    render(<DocumentChecklist applicantAddress="GApplicant" loanType="purchase" pollIntervalMs={60000} />);
    await screen.findAllByText("Not submitted", { selector: "span" });

    const input = screen.getByLabelText("Upload Government-issued identity document");
    const file = new File(["document"], "identity.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const formData = fetchMock.mock.calls[1][1]?.body as FormData;
    expect(formData.get("documentType")).toBe("identity");
    expect(formData.get("document")).toBe(file);
  });

  it("renders each document state and offers resubmission only for rejected items", async () => {
    const mixed = [
      { documentType: "income", status: "Uploaded" },
      { documentType: "bank_statement", status: "Accepted" },
      {
        documentType: "property_contract",
        status: "Rejected",
        reviewMessage: "Agreement is missing the seller's signature.",
      },
    ].map((entry, index) => ({
      documentId: `document-${index}`,
      originalName: `${entry.documentType}.pdf`,
      uploadedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
      ...entry,
    }));
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => mixed }) as jest.Mock;

    render(<DocumentChecklist applicantAddress="GApplicant" loanType="purchase" pollIntervalMs={60000} />);

    const identity = await screen.findByTestId("document-item-identity");
    await waitFor(() =>
      expect(screen.getByTestId("document-item-property_contract")).toHaveAttribute("data-state", "rejected")
    );
    expect(identity).toHaveAttribute("data-state", "not_submitted");
    expect(screen.getByTestId("document-item-income")).toHaveAttribute("data-state", "pending_review");
    expect(screen.getByTestId("document-item-bank_statement")).toHaveAttribute("data-state", "approved");

    expect(screen.getByText("Not submitted", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("Pending review", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("Approved", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("Rejected", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("Agreement is missing the seller's signature.")).toBeInTheDocument();
    expect(screen.getByTestId("document-checklist-summary")).toHaveTextContent(
      "1 of 4 required documents approved"
    );

    // Resubmission is offered only for the rejected document.
    expect(screen.getAllByLabelText(/^Resubmit /)).toHaveLength(1);
    expect(screen.getByLabelText("Resubmit Property purchase agreement")).toBeInTheDocument();
    // A never-submitted item links to its upload action instead.
    expect(screen.getByLabelText("Upload Government-issued identity document")).toBeInTheDocument();
    // Pending and approved items offer no action at all.
    expect(screen.queryByTestId("document-action-income")).not.toBeInTheDocument();
    expect(screen.queryByTestId("document-action-bank_statement")).not.toBeInTheDocument();
  });
});
