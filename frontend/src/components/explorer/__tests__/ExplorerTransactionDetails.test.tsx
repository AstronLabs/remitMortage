// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { render, screen } from "@testing-library/react";
import ExplorerTransactionDetails, {
  ExplorerTransactionRecord,
} from "../ExplorerTransactionDetails";

function makeTransaction(
  overrides: Partial<ExplorerTransactionRecord> = {}
): ExplorerTransactionRecord {
  return {
    hash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef12345678",
    ledger: 123456,
    createdAt: "2026-01-01T12:00:00Z",
    sourceAccount: "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF",
    feeCharged: "100",
    operationCount: 2,
    memo: "milestone-1",
    successful: true,
    ...overrides,
  };
}

describe("ExplorerTransactionDetails", () => {
  it("renders the full transaction hash and a successful badge", () => {
    render(<ExplorerTransactionDetails transaction={makeTransaction()} />);

    expect(
      screen.getByText("abcdef1234567890abcdef1234567890abcdef1234567890abcdef12345678")
    ).toBeInTheDocument();
    expect(screen.getByText("Successful")).toBeInTheDocument();
    expect(screen.getByText("123456")).toBeInTheDocument();
    expect(screen.getByText("100 stroops")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("milestone-1")).toBeInTheDocument();
  });

  it("renders a failed badge for an unsuccessful transaction", () => {
    render(<ExplorerTransactionDetails transaction={makeTransaction({ successful: false })} />);
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("omits the memo row when no memo is present", () => {
    render(<ExplorerTransactionDetails transaction={makeTransaction({ memo: undefined })} />);
    expect(screen.queryByText("Memo")).not.toBeInTheDocument();
  });
});
