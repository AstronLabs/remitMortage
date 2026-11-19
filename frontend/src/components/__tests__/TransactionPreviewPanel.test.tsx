// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * The preview panel (issue #884).
 *
 * Three states that mean different things, and must look different: still
 * simulating, blocked, and ready. The panel must never present a blocked
 * transaction as though it is about to happen.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import TransactionPreviewPanel from "../tx/TransactionPreviewPanel";
import type { TransactionPreview } from "../../lib/transaction-preview";

function readyPreview(overrides: Partial<TransactionPreview> = {}): TransactionPreview {
  return {
    kind: "escrow_deposit",
    summary: "Move 100.5 USDC from your wallet into your savings escrow.",
    effects: [
      { kind: "debit", text: "100.5 USDC leaves your wallet", amount: "100.5", asset: "USDC" },
      { kind: "credit", text: "Credited to your savings escrow (CA3D5K…GAXE)" },
      { kind: "fee", text: "Network fee of up to 0.00001 XLM (about $0.0000)" },
    ],
    warnings: [],
    fee: { stroops: 100, label: "0.00001 XLM", usd: "0.0000" },
    ok: true,
    requiresAcknowledgement: false,
    ...overrides,
  };
}

describe("TransactionPreviewPanel", () => {
  it("says it is still simulating before a preview exists", () => {
    render(<TransactionPreviewPanel preview={null} loading />);

    expect(screen.getByText(/Simulating the transaction/i)).toBeInTheDocument();
    expect(screen.queryByTestId("transaction-preview")).not.toBeInTheDocument();
  });

  it("shows the summary and every effect once ready", () => {
    render(<TransactionPreviewPanel preview={readyPreview()} />);

    expect(
      screen.getByText("Move 100.5 USDC from your wallet into your savings escrow.")
    ).toBeInTheDocument();
    expect(screen.getByText("100.5 USDC leaves your wallet")).toBeInTheDocument();
    expect(screen.getByText(/Network fee of up to 0.00001 XLM/)).toBeInTheDocument();
  });

  it("states plainly that nothing was signed when the preview is blocked", () => {
    render(
      <TransactionPreviewPanel
        preview={readyPreview({
          ok: false,
          failureReason: "Simulation failed, so your wallet was not asked to sign: no trustline",
          warnings: [
            { code: "simulation_failed", severity: "danger", text: "The network rejected it." },
          ],
        })}
      />
    );

    expect(screen.getByTestId("transaction-preview-blocked")).toBeInTheDocument();
    expect(screen.getByText(/was not sent to your wallet/i)).toBeInTheDocument();
    expect(screen.getByText(/no trustline/)).toBeInTheDocument();
    expect(screen.getByText(/no fee was charged/i)).toBeInTheDocument();
    // A blocked preview must not list effects as though they will happen.
    expect(screen.queryByText("100.5 USDC leaves your wallet")).not.toBeInTheDocument();
  });

  it("renders a warning without demanding acknowledgement when it is not a danger", () => {
    render(
      <TransactionPreviewPanel
        preview={readyPreview({
          warnings: [
            {
              code: "penalty_applied",
              severity: "warning",
              text: "Withdrawing early costs 5% of your balance.",
            },
          ],
        })}
        onAcknowledgedChange={() => {}}
      />
    );

    expect(screen.getByText(/costs 5% of your balance/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("requires an explicit acknowledgement for a danger warning", async () => {
    const onAcknowledgedChange = jest.fn();
    render(
      <TransactionPreviewPanel
        preview={readyPreview({
          requiresAcknowledgement: true,
          warnings: [
            {
              code: "amount_mismatch",
              severity: "danger",
              text: "You entered 100.5 but this transaction moves 999.",
            },
          ],
        })}
        onAcknowledgedChange={onAcknowledgedChange}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "You entered 100.5 but this transaction moves 999."
    );

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeChecked();

    await userEvent.click(checkbox);
    expect(onAcknowledgedChange).toHaveBeenCalledWith(true);
  });

  it("pluralises the acknowledgement for several warnings", () => {
    render(
      <TransactionPreviewPanel
        preview={readyPreview({
          requiresAcknowledgement: true,
          warnings: [
            { code: "amount_mismatch", severity: "danger", text: "Amount differs." },
            { code: "unexpected_recipient", severity: "danger", text: "Unknown recipient." },
          ],
        })}
        onAcknowledgedChange={() => {}}
      />
    );

    expect(screen.getByText(/read the 2 warnings above/i)).toBeInTheDocument();
  });
});
