// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Keyboard-only navigation checks for the core flows (issue #696): loan
 * application, milestone approval, and investor deposit. Each flow is driven
 * with Tab / Shift+Tab / Enter / Escape / Arrow keys only, and axe-core runs
 * its focus and tab order rules against the rendered DOM.
 *
 * Manual checklist for new flows: docs/KEYBOARD_ACCESSIBILITY.md
 */

import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import ApplicationPage from "../src/app/application/page";
import AdminPage from "../src/app/admin/page";
import InvestPage from "../src/app/invest/page";
import DepositModal from "../src/components/DepositModal";

const mockWallet = {
  publicKey: "GADMINADDRESS0000000000000000000000000000000000000000000",
  isConnected: true,
  usdcBalance: "1000",
  wrongNetwork: false,
  walletError: null,
  connect: jest.fn(),
};

jest.mock("next/dynamic", () => () => () => null);
jest.mock("@/context/WalletContext", () => {
  // The admin page reads this at module load; mock factories run before it.
  process.env.NEXT_PUBLIC_ADMIN_ADDRESS =
    "GADMINADDRESS0000000000000000000000000000000000000000000";
  return {
    useWallet: () => mockWallet,
    OptionalWalletProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});
jest.mock("@/hooks/useTransactionMonitor", () => ({ useTransactionMonitor: () => ({}) }));
jest.mock("@/hooks/useXlmPrice", () => ({ useXlmPrice: () => 0.12 }));
jest.mock("@/lib/analytics", () => ({ track: jest.fn() }));
jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
  Toaster: () => null,
}));
jest.mock("@/components/ActiveLoansMapView", () => () => null);
jest.mock("@/components/AuditLogViewer", () => () => null);
jest.mock("@/components/LoanCommentsPanel", () => () => null);
jest.mock("@/components/ROIProjectionWidget", () => () => null);
jest.mock("@/components/governance/GovernanceVotingModal", () => ({
  GovernanceVotingModal: () => null,
}));
jest.mock("@/components/governance/SubmitProposalModal", () => ({
  SubmitProposalModal: () => null,
}));
jest.mock("@/components/governance/QuorumProgressBar", () => ({ QuorumProgressBar: () => null }));
jest.mock("@/hooks/useGovernanceProposals", () => ({
  useGovernanceProposals: () => ({
    proposals: [],
    loading: false,
    error: null,
    submitVote: jest.fn(),
    createProposal: jest.fn(),
  }),
}));

/** axe-core rules that cover focus, tab order, and keyboard operability. */
const FOCUS_RULES = [
  "tabindex",
  "focus-order-semantics",
  "aria-hidden-focus",
  "nested-interactive",
  "scrollable-region-focusable",
  "frame-focusable-content",
  "button-name",
  "link-name",
  "label",
  "aria-dialog-name",
  "aria-required-children",
  "aria-required-parent",
  "aria-valid-attr-value",
];

async function expectNoFocusViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "rule", values: FOCUS_RULES } });
  const violations = results.violations.map((v) => ({
    rule: v.id,
    nodes: v.nodes.map((n) => n.target.join(" ")),
  }));
  expect(violations).toEqual([]);
}

beforeEach(() => {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => [],
  })) as unknown as typeof fetch;
});

afterEach(() => {
  jest.clearAllMocks();
});

describe("Loan application flow", () => {
  it("has no focus or tab order violations", async () => {
    const { container } = render(<ApplicationPage />);
    await expectNoFocusViolations(container);
  });

  it("can be completed with the keyboard only", async () => {
    const user = userEvent.setup();
    (global.fetch as jest.Mock).mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? { ok: true, json: async () => ({ id: "app-1", amount: "70000", status: "Pending" }) }
        : { ok: true, json: async () => [] }
    );
    render(<ApplicationPage />);

    await user.tab();
    expect(screen.getByLabelText("Requested principal")).toHaveFocus();
    await user.keyboard("70000");

    await user.tab();
    expect(screen.getByTestId("loan-submit")).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("status")).toHaveTextContent(/submitted/i);
  });
});

describe("Milestone approval flow", () => {
  it("switches tabs with arrow keys and exposes tab semantics", async () => {
    const user = userEvent.setup();
    const { container } = render(<AdminPage />);
    const loansTab = await screen.findByRole("tab", { name: /Pending Loans/ });

    await user.tab();
    expect(loansTab).toHaveFocus();
    expect(loansTab).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowRight}");
    const milestonesTab = screen.getByRole("tab", { name: /Milestone Reviews/ });
    expect(milestonesTab).toHaveFocus();
    expect(milestonesTab).toHaveAttribute("aria-selected", "true");
    expect(loansTab).toHaveAttribute("tabindex", "-1");

    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: /Audit Log/ })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(loansTab).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: /Audit Log/ })).toHaveFocus();

    await expectNoFocusViolations(container);
  });

  it("approves a milestone with the keyboard, trapping and returning focus", async () => {
    const user = userEvent.setup();
    render(<AdminPage />);
    await screen.findByRole("tab", { name: /Pending Loans/ });

    await user.tab();
    await user.keyboard("{ArrowRight}");
    await user.tab();
    expect(screen.getByRole("tabpanel")).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: /View on IPFS/ })).toHaveFocus();
    await user.tab();
    const approve = screen.getByRole("button", { name: "Approve Disbursement" });
    expect(approve).toHaveFocus();

    // Escape closes the dialog and focus returns to the opener.
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", { name: "Confirm transaction" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const sign = screen.getByRole("button", { name: "Sign with Freighter" });
    expect(cancel).toHaveFocus();
    await expectNoFocusViolations(dialog);

    await user.tab();
    expect(sign).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(sign).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(approve).toHaveFocus();

    // Reopen and confirm.
    await user.keyboard("{Enter}");
    await user.tab();
    await user.keyboard("{Enter}");

    const toast = jest.requireMock("react-hot-toast").default;
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Milestone disbursement approved.")
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("Investor deposit flow", () => {
  beforeEach(() => {
    (global.fetch as jest.Mock).mockImplementation(async () => ({
      ok: true,
      json: async () => ({ poolApyBps: 620, seniorApyBps: 500, juniorApyBps: 900 }),
    }));
  });

  it("has no focus or tab order violations", async () => {
    const { container } = render(<InvestPage />);
    await screen.findByRole("group", { name: "Select Capital Tranche" });
    await expectNoFocusViolations(container);
  });

  it("selects a tranche with arrow keys and submits the deposit with Enter", async () => {
    const user = userEvent.setup();
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);
    render(<InvestPage />);

    const senior = await screen.findByRole("radio", { name: /Senior Tranche/ });
    act(() => senior.focus());
    await user.keyboard("{ArrowRight}");
    const junior = screen.getByRole("radio", { name: /Junior Tranche/ });
    expect(junior).toHaveFocus();
    expect(junior).toBeChecked();

    await user.tab();
    expect(screen.getByLabelText("Deposit Amount (USDC)")).toHaveFocus();
    await user.keyboard("2500");
    await user.tab();
    expect(screen.getByRole("button", { name: /Deposit into Junior Tranche/ })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("Junior tranche"));
    confirmSpy.mockRestore();
  });

  it("traps focus in the auto-reinvest dialog and restores it on Escape", async () => {
    const user = userEvent.setup();
    render(<InvestPage />);

    const toggle = await screen.findByRole("button", { name: "Toggle auto-reinvest yield" });
    act(() => toggle.focus());
    await user.keyboard("{Enter}");

    const dialog = screen.getByRole("dialog", { name: "Enable Auto-Reinvest" });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await expectNoFocusViolations(dialog);

    for (let i = 0; i < 5; i++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });
});

describe("Escrow deposit dialog", () => {
  function Harness() {
    const [open, setOpen] = React.useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open deposit</button>
        <DepositModal isOpen={open} onClose={() => setOpen(false)} />
      </>
    );
  }

  it("focuses the amount field, keeps Tab inside, and returns focus on Escape", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const opener = screen.getByRole("button", { name: "Open deposit" });
    await user.tab();
    expect(opener).toHaveFocus();
    await user.keyboard("{Enter}");

    const dialog = screen.getByRole("dialog", { name: "Deposit USDC" });
    expect(screen.getByLabelText("Amount (USDC)")).toHaveFocus();
    await expectNoFocusViolations(dialog);

    for (let i = 0; i < 6; i++) {
      await user.tab({ shift: i % 2 === 1 });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
