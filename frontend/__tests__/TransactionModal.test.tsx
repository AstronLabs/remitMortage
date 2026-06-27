import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import TransactionModal from "../src/components/tx/TransactionModal";
import { formatTransactionErrorMessage } from "../src/lib/transaction-status";

describe("formatTransactionErrorMessage", () => {
  it("strips transport prefixes from submission errors", () => {
    expect(formatTransactionErrorMessage("Simulation failed: insufficient balance")).toBe(
      "insufficient balance"
    );
    expect(formatTransactionErrorMessage("Submission failed: txBadSeq")).toBe(
      "txBadSeq"
    );
  });

  it("rephrases Soroban host function failures", () => {
    expect(
      formatTransactionErrorMessage("Submission failed: trInvokeHostFunctionMalformed")
    ).toContain("contract rejected");
  });
});

describe("TransactionModal", () => {
  const hash = "a".repeat(64);

  it("blocks dismissal while the transaction is pending", () => {
    const onClose = jest.fn();

    render(
      <TransactionModal
        isOpen
        phase="pending"
        transactionType="Deposit"
        hash={hash}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByTestId("transaction-modal-backdrop"));
    fireEvent.click(screen.getByLabelText(/close transaction modal/i));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/close transaction modal/i)).toBeDisabled();
    expect(screen.getByText(/locked while pending/i)).toBeInTheDocument();
  });

  it("renders both explorer links and allows closing after success", () => {
    const onClose = jest.fn();

    render(
      <TransactionModal
        isOpen
        phase="success"
        transactionType="Deposit"
        hash={hash}
        onClose={onClose}
      />
    );

    expect(screen.getByRole("link", { name: /view on stellarchain/i })).toHaveAttribute(
      "href",
      expect.stringContaining(hash)
    );
    expect(screen.getByRole("link", { name: /view on stellar expert/i })).toHaveAttribute(
      "href",
      expect.stringContaining(hash)
    );

    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows cleaned contract errors after rejection", () => {
    render(
      <TransactionModal
        isOpen
        phase="error"
        transactionType="Withdrawal"
        errorMessage="Submission failed: trInvokeHostFunctionMalformed"
        onClose={jest.fn()}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The contract rejected the transaction"
    );
  });
});
