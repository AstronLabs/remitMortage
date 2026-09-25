// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

const mockCall = jest.fn();
const mockTransaction = jest.fn(() => ({ call: mockCall }));
const mockTransactions = jest.fn(() => ({ transaction: mockTransaction }));

jest.mock("@stellar/stellar-sdk", () => ({
  Horizon: {
    Server: jest.fn().mockImplementation(() => ({
      transactions: mockTransactions,
    })),
  },
}));

import { fetchTransaction } from "../explorerTransactions";

describe("fetchTransaction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("maps a Horizon transaction record to the explorer shape", async () => {
    mockCall.mockResolvedValueOnce({
      hash: "hash123",
      ledger_attr: 42,
      created_at: "2026-01-01T00:00:00Z",
      source_account: "GSOURCE",
      fee_charged: "100",
      operation_count: 3,
      memo: "note",
      successful: true,
    });

    const result = await fetchTransaction("hash123");

    expect(result).toEqual({
      hash: "hash123",
      ledger: 42,
      createdAt: "2026-01-01T00:00:00Z",
      sourceAccount: "GSOURCE",
      feeCharged: "100",
      operationCount: 3,
      memo: "note",
      successful: true,
    });
    expect(mockTransaction).toHaveBeenCalledWith("hash123");
  });

  it("returns null when Horizon lookup fails (e.g. 404)", async () => {
    mockCall.mockRejectedValueOnce(new Error("Not Found"));

    const result = await fetchTransaction("missing-hash");

    expect(result).toBeNull();
  });
});
