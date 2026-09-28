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

    expect(await screen.findAllByText("Missing", { selector: "span" })).toHaveLength(4);
    expect(screen.getByText(/Submission is unavailable until all required documents are accepted/)).toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(onEligibilityChange).toHaveBeenLastCalledWith(true));
    expect(screen.getAllByText("Accepted", { selector: "span" })).toHaveLength(4);
    expect(screen.queryByText(/Submission is unavailable/)).not.toBeInTheDocument();
  });

  it("uploads the selected document type and refreshes status", async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ documentId: "new-id" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });
    global.fetch = fetchMock as jest.Mock;
    render(<DocumentChecklist applicantAddress="GApplicant" loanType="purchase" pollIntervalMs={60000} />);
    await screen.findAllByText("Missing", { selector: "span" });

    const input = screen.getByLabelText("Upload Government-issued identity document");
    const file = new File(["document"], "identity.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const formData = fetchMock.mock.calls[1][1]?.body as FormData;
    expect(formData.get("documentType")).toBe("identity");
    expect(formData.get("document")).toBe(file);
  });
});