// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import SkipToContent from "../SkipToContent";
import Footer from "../Footer";
import DepositModal from "../DepositModal";
import WithdrawModal from "../WithdrawModal";

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

// Mock WalletContext
jest.mock("@/context/WalletContext", () => ({
  useWallet: () => ({
    isConnected: true,
    publicKey: "GBX...1234",
    usdcBalance: "1000",
    wrongNetwork: false,
    walletError: null,
    connect: jest.fn(),
  }),
}));

// Mock custom hooks
jest.mock("@/hooks/useTransactionMonitor", () => ({
  useTransactionMonitor: () => ({}),
}));

jest.mock("@/hooks/useXlmPrice", () => ({
  useXlmPrice: () => 0.12,
}));

describe("Accessible Navigation Landmarks & Skip Links (#485)", () => {
  it("renders the SkipToContent link targeting #main-content with accessible text", () => {
    render(<SkipToContent />);
    const skipLink = screen.getByRole("link", { name: /skip to main content/i });
    expect(skipLink).toBeInTheDocument();
    expect(skipLink).toHaveAttribute("href", "#main-content");
    expect(skipLink).toHaveClass("sr-only");
  });

  it("renders Footer with semantic contentinfo landmark and accessible links", () => {
    render(<Footer />);
    const footer = screen.getByRole("contentinfo");
    expect(footer).toBeInTheDocument();
    expect(footer).toHaveClass("rm-footer");

    const navs = screen.getAllByRole("navigation");
    expect(navs.length).toBeGreaterThanOrEqual(2);
  });

  it("renders DepositModal with accessible dialog role and title labelling", () => {
    render(<DepositModal isOpen={true} onClose={jest.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "deposit-modal-title");

    const title = screen.getByText("Deposit USDC");
    expect(title).toHaveAttribute("id", "deposit-modal-title");
  });

  it("renders WithdrawModal with accessible dialog role and title labelling", () => {
    render(<WithdrawModal isOpen={true} onClose={jest.fn()} deposited="1000" />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "withdraw-modal-title");

    const title = screen.getByText("Early Withdrawal");
    expect(title).toHaveAttribute("id", "withdraw-modal-title");
  });
});
